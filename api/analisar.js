const https = require('https');

const rateLimit = new Map();
const LIMITE_POR_IP = 5;
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

function httpPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Erro ao parsear resposta: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function buscarTavily(nome, cidade, data) {
  const apiKey = process.env.TAVILY_API_KEY;
  const queries = [
    `${nome} desaparecido ${cidade}`,
    `${nome} ${cidade} desaparecimento`,
    `${nome} desaparecido ${data}`
  ];

  const resultados = [];

  for (const query of queries) {
    try {
      const body = JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: false
      });

      const res = await httpPost(
        'api.tavily.com',
        '/search',
        { 'Content-Type': 'application/json' },
        body
      );

      if (res.results) {
        res.results.forEach(r => {
          resultados.push({
            titulo: r.title || '',
            url: r.url || '',
            conteudo: r.content || ''
          });
        });
      }
    } catch (e) {
      console.error('Erro Tavily query:', e.message);
    }
  }

  // Remove duplicatas por URL
  const unicos = [];
  const urls = new Set();
  for (const r of resultados) {
    if (!urls.has(r.url)) {
      urls.add(r.url);
      unicos.push(r);
    }
  }

  return unicos.slice(0, 10);
}

function buildPrompt(d, resultadosWeb) {
  const temResultados = resultadosWeb && resultadosWeb.length > 0;

  const secaoWeb = temResultados
    ? `\nRESULTADOS REAIS ENCONTRADOS NA WEB (${resultadosWeb.length} fontes):\n` +
      resultadosWeb.map((r, i) =>
        `[${i + 1}] ${r.titulo}\nURL: ${r.url}\nConteúdo: ${r.conteudo.slice(0, 400)}`
      ).join('\n\n')
    : '\nNenhum resultado encontrado na web para este caso.';

  return [
    `Você é um especialista em investigação de desaparecimentos com foco em análise OSINT.`,
    `Analise o caso a seguir usando os dados fornecidos pela família E os resultados reais encontrados na web.`,
    `Responda APENAS com JSON puro e válido, sem texto antes ou depois, sem markdown.`,
    ``,
    `DADOS FORNECIDOS PELA FAMÍLIA:`,
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
    secaoWeb,
    ``,
    `Com base em TUDO acima, responda SOMENTE com este JSON:`,
    `{`,
    `  "resumo": "string — resumo objetivo integrando dados da família e da web",`,
    `  "urgencia": "alta|media|baixa",`,
    `  "urgencia_motivo": "string",`,
    `  "fontes_encontradas": ["lista de títulos/URLs relevantes encontrados na web"],`,
    `  "hipoteses": [{"titulo":"string","probabilidade":"alta|media|baixa","descricao":"string baseada nos dados reais","indicadores":["string"]}],`,
    `  "timeline": [{"data":"string","titulo":"string","descricao":"string","cor":"red|amber|green|gray"}],`,
    `  "locais_busca": {"imediato":["string"],"secundario":["string"],"digital":["string"]},`,
    `  "orientacoes_familia": ["string"],`,
    `  "orientacoes_investigadores": ["string"],`,
    `  "alertas": ["string"],`,
    `  "proximos_passos": ["string"]`,
    `}`,
    ``,
    `IMPORTANTE: Use os resultados da web para enriquecer a análise. Se encontrou notícias reais, mencione-as nas hipóteses e timeline. Produza 3 a 5 hipóteses. Seja específico, não genérico.`
  ].filter(Boolean).join('\n');
}

async function chamarGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;

  const body = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: 'Você é um especialista em investigação de desaparecimentos. Responda SEMPRE com JSON puro e válido, sem texto adicional, sem markdown, sem blocos de código.'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 4000,
    response_format: { type: 'json_object' }
  });

  const res = await httpPost(
    'api.groq.com',
    '/openai/v1/chat/completions',
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body
  );

  if (res.error) throw new Error(res.error.message);
  const text = res.choices?.[0]?.message?.content || '';
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(clean);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checarRateLimit(ip)) {
    return res.status(429).json({ error: 'Limite de análises atingido. Tente novamente amanhã.' });
  }

  const { nome, cidade, data } = req.body || {};
  if (!nome || !cidade || !data) {
    return res.status(400).json({ error: 'Campos obrigatórios: nome, cidade e data.' });
  }

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY não configurada.' });
  if (!process.env.TAVILY_API_KEY) return res.status(500).json({ error: 'TAVILY_API_KEY não configurada.' });

  try {
    // Busca na web e análise em paralelo — mais rápido
    const resultadosWeb = await buscarTavily(nome, cidade, data);
    const prompt = buildPrompt(req.body, resultadosWeb);
    const resultado = await chamarGroq(prompt);

    // Adiciona as fontes encontradas na resposta
    resultado.total_fontes_web = resultadosWeb.length;

    return res.status(200).json(resultado);
  } catch (err) {
    console.error('Erro:', err);
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
};
