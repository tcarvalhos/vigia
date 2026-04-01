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
        catch (e) { reject(new Error('Erro ao parsear resposta')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function buscarTavily(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  try {
    const body = JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: false
    });
    const res = await httpPost('api.tavily.com', '/search',
      { 'Content-Type': 'application/json' }, body);
    return res.results || [];
  } catch (e) {
    console.error('Tavily erro:', e.message);
    return [];
  }
}

async function coletarFontes(nome, cidade, data) {
  const estado = cidade.split(',')[1]?.trim().toUpperCase() || '';

  const queries = [
    // Busca geral
    `"${nome}" desaparecido ${cidade}`,
    `"${nome}" desaparecimento ${cidade}`,
    // Portais de notícia regionais
    `"${nome}" desaparecido site:g1.globo.com OR site:uol.com.br OR site:r7.com`,
    // Polícia Civil e órgãos oficiais
    `"${nome}" desaparecido site:pc.pr.gov.br OR site:ssp.sp.gov.br OR site:policiacivil.rj.gov.br OR site:seguranca.ba.gov.br`,
    // SOS Desaparecidos e ONGs
    `"${nome}" site:sosdesaparecidos.com.br OR site:desaparecidos.org.br OR site:childhood.org.br`,
    // Redes sociais indexadas
    `"${nome}" desaparecido ${cidade} facebook OR instagram`,
  ];

  const todosResultados = [];
  const urlsVistas = new Set();

  for (const q of queries) {
    const resultados = await buscarTavily(q);
    for (const r of resultados) {
      if (!urlsVistas.has(r.url)) {
        urlsVistas.add(r.url);
        todosResultados.push({
          titulo: r.title || '',
          url: r.url || '',
          conteudo: (r.content || '').slice(0, 500),
          fonte: classificarFonte(r.url)
        });
      }
    }
  }

  return todosResultados.slice(0, 15);
}

function classificarFonte(url) {
  if (!url) return 'web';
  if (url.includes('pc.pr.gov.br') || url.includes('ssp.') || url.includes('policiacivil') || url.includes('seguranca.') || url.includes('gov.br')) return 'oficial';
  if (url.includes('sosdesaparecidos') || url.includes('desaparecidos.org') || url.includes('childhood')) return 'ong';
  if (url.includes('g1.') || url.includes('uol.') || url.includes('r7.') || url.includes('band.') || url.includes('folha.') || url.includes('estadao.')) return 'midia';
  if (url.includes('facebook') || url.includes('instagram') || url.includes('twitter') || url.includes('tiktok')) return 'social';
  return 'web';
}

function buildPrompt(d, fontes) {
  const temFontes = fontes && fontes.length > 0;

  const secaoFontes = temFontes
    ? `\nFONTES ENCONTRADAS NA WEB (${fontes.length} resultados):\n` +
      fontes.map((r, i) =>
        `[${i + 1}] [${r.fonte.toUpperCase()}] ${r.titulo}\nURL: ${r.url}\nConteúdo: ${r.conteudo}`
      ).join('\n\n')
    : '\nNenhuma fonte encontrada na web.';

  return [
    `Você é um analista especializado em investigação de desaparecimentos. Sua função é cruzar dados fornecidos pela família com informações encontradas na web e produzir uma análise investigativa estruturada.`,
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
    secaoFontes,
    ``,
    `INSTRUÇÕES IMPORTANTES:`,
    `1. Cruze os dados da família com as fontes web. Se houver contradições entre o que a família diz e o que as fontes publicam, registre em "divergencias".`,
    `2. Se fontes oficiais (polícia, governo) divergem de fontes sociais ou familiares, isso é especialmente relevante.`,
    `3. Cite as fontes reais encontradas nas hipóteses e na timeline sempre que possível.`,
    `4. Seja específico — use nomes de lugares, datas e detalhes reais encontrados.`,
    `5. Não invente fatos. Se não há informação, diga que não foi encontrada.`,
    ``,
    `Responda SOMENTE com este JSON:`,
    `{`,
    `  "resumo": "string — resumo objetivo integrando dados da família e fontes web",`,
    `  "urgencia": "alta|media|baixa",`,
    `  "urgencia_motivo": "string",`,
    `  "divergencias": [`,
    `    {`,
    `      "descricao": "string — descrição neutra da divergência encontrada entre fontes",`,
    `      "fonte_a": "string — o que uma fonte diz",`,
    `      "fonte_b": "string — o que outra fonte diz"`,
    `    }`,
    `  ],`,
    `  "fontes_encontradas": [`,
    `    {`,
    `      "titulo": "string",`,
    `      "url": "string",`,
    `      "tipo": "oficial|midia|ong|social|web",`,
    `      "relevancia": "alta|media|baixa"`,
    `    }`,
    `  ],`,
    `  "hipoteses": [`,
    `    {`,
    `      "titulo": "string",`,
    `      "probabilidade": "alta|media|baixa",`,
    `      "descricao": "string — baseada nos dados reais, cite fontes quando possível",`,
    `      "indicadores": ["string"]`,
    `    }`,
    `  ],`,
    `  "timeline": [{"data":"string","titulo":"string","descricao":"string","cor":"red|amber|green|gray"}],`,
    `  "locais_busca": {"imediato":["string"],"secundario":["string"],"digital":["string"]},`,
    `  "orientacoes_familia": ["string"],`,
    `  "orientacoes_investigadores": ["string"],`,
    `  "alertas": ["string"],`,
    `  "proximos_passos": ["string"]`,
    `}`,
    ``,
    `Produza 3 a 5 hipóteses. O array "divergencias" pode ser vazio [] se não houver divergências. Seja analítico e específico.`
  ].filter(Boolean).join('\n');
}

async function chamarGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;
  const body = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: 'Você é um analista de inteligência especializado em desaparecimentos. Responda SEMPRE com JSON puro e válido, sem texto adicional, sem markdown, sem blocos de código.'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 4000,
    response_format: { type: 'json_object' }
  });

  const res = await httpPost('api.groq.com', '/openai/v1/chat/completions', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  }, body);

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
    const fontes = await coletarFontes(nome, cidade, data);
    const prompt = buildPrompt(req.body, fontes);
    const resultado = await chamarGroq(prompt);
    resultado.total_fontes_web = fontes.length;
    return res.status(200).json(resultado);
  } catch (err) {
    console.error('Erro:', err);
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
};
