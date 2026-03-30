const https = require('https');

// Rate limiting simples em memória (reseta quando a função reinicia)
const rateLimit = new Map();
const LIMITE_POR_IP = 10;
const JANELA_MS = 24 * 60 * 60 * 1000; // 24 horas

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
  return [
    `Você é um especialista em investigação de desaparecimentos com foco em análise OSINT e inteligência investigativa.`,
    `Analise o caso a seguir e produza um relatório completo APENAS em JSON válido, sem texto antes ou depois, sem markdown.`,
    ``,
    `DADOS DO CASO:`,
    `- Nome: ${d.nome}`,
    `- Cidade: ${d.cidade}`,
    `- Data: ${d.data}`,
    d.idade    ? `- Idade: ${d.idade}` : null,
    d.sexo     ? `- Sexo: ${d.sexo}` : null,
    d.veiculo  ? `- Veículo: ${d.veiculo}` : null,
    d.local    ? `- Último local: ${d.local}` : null,
    d.contato  ? `- Último contato: ${d.contato}` : null,
    d.contexto ? `- Contexto: ${d.contexto}` : null,
    d.feito    ? `- O que já foi feito: ${d.feito}` : null,
    ``,
    `Responda SOMENTE com JSON puro (sem nada mais):`,
    `{`,
    `  "resumo": "string",`,
    `  "urgencia": "alta|media|baixa",`,
    `  "urgencia_motivo": "string",`,
    `  "hipoteses": [{"titulo":"","probabilidade":"alta|media|baixa","descricao":"","indicadores":[]}],`,
    `  "timeline": [{"data":"","titulo":"","descricao":"","cor":"red|amber|green|gray"}],`,
    `  "locais_busca": {"imediato":[],"secundario":[],"digital":[]},`,
    `  "orientacoes_familia": [],`,
    `  "orientacoes_investigadores": [],`,
    `  "alertas": [],`,
    `  "proximos_passos": []`,
    `}`,
    ``,
    `Produza 3 a 5 hipóteses plausíveis. Seja específico para este caso. Não invente fatos não mencionados.`
  ].filter(Boolean).join('\n');
}

function chamarGemini(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GEMINI_API_KEY;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 3000 }
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          resolve(JSON.parse(clean));
        } catch (e) {
          reject(new Error('Erro ao processar resposta da IA'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  // Rate limit por IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checarRateLimit(ip)) {
    return res.status(429).json({ error: 'Limite de análises atingido. Tente novamente amanhã.' });
  }

  const { nome, cidade, data } = req.body || {};
  if (!nome || !cidade || !data) {
    return res.status(400).json({ error: 'Campos obrigatórios: nome, cidade e data.' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Chave de API não configurada.' });
  }

  try {
    const prompt = buildPrompt(req.body);
    const resultado = await chamarGemini(prompt);
    return res.status(200).json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
};
