const https = require('https');

const rateLimit = new Map();
const LIMITE_POR_IP = 10;
const JANELA_MS = 24 * 60 * 60 * 1000;

function checarRateLimit(ip) {
  const agora = Date.now();
  const entrada = rateLimit.get(ip);
  if (!entrada || agora - entrada.inicio > JANELA_MS) {
    rateLimit.set(ip, { count: 1, inicio: agora });
    return true;
  }
  if (entrada.count >= LIMITE_POR_IP) return false;
  entrada.count++;
  return true;
}

function buildPrompt(d) {
  return `Você é um especialista em investigação de desaparecimentos e análise OSINT.
Analise o caso abaixo e retorne APENAS um JSON puro, sem markdown.

DADOS:
- Nome: ${d.nome}
- Local: ${d.cidade}
- Data: ${d.data}
- Veículo: ${d.veiculo || 'Não informado'}
- Contexto: ${d.contexto || 'Não informado'}

RETORNO ESPERADO (JSON):
{
  "resumo": "string",
  "urgencia": "alta|media|baixa",
  "urgencia_motivo": "string",
  "hipoteses": [{"titulo":"","probabilidade":"alta|media|baixa","descricao":"","indicadores":[]}],
  "timeline": [{"data":"","titulo":"","descricao":"","cor":"red|amber|green|gray"}],
  "locais_busca": {"imediato":[],"secundario":[],"digital":[]},
  "orientacoes_familia": [],
  "orientacoes_investigadores": [],
  "alertas": [],
  "proximos_passos": []
}`;
}

async function chamarGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 3000 }
  });

  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          const text = json.candidates[0].content.parts[0].text;
          const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
          resolve(JSON.parse(clean));
        } catch (e) {
          reject(new Error("Erro na resposta da IA. Verifique os dados."));
        }
      });
    });

    req.on('error', (e) => reject(new Error("Erro de conexão: " + e.message)));
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checarRateLimit(ip)) return res.status(429).json({ error: 'Limite diário atingido.' });

  try {
    const resultado = await chamarGemini(buildPrompt(req.body));
    res.status(200).json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
