const https = require('https');

// ── Rate limiting ─────────────────────────────────
const rateLimit = new Map();
function checarRateLimit(ip) {
  const agora = Date.now();
  const entrada = rateLimit.get(ip);
  const JANELA = 24 * 60 * 60 * 1000;
  const LIMITE = 5;
  if (!entrada || agora - entrada.inicio > JANELA) {
    rateLimit.set(ip, { count: 1, inicio: agora });
    return true;
  }
  if (entrada.count >= LIMITE) return false;
  entrada.count++;
  return true;
}

// ── HTTP helper ───────────────────────────────────
function httpPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Resposta inválida da API: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Tavily search ─────────────────────────────────
async function tavily(query, maxResults = 5) {
  try {
    const body = JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query, search_depth: 'basic', max_results: maxResults,
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

// ── Classificar fonte ─────────────────────────────
function classificarFonte(url) {
  if (!url) return 'web';
  if (url.includes('gov.br') || url.includes('policiacivil') || url.includes('ssp.') || url.includes('pc.pr') || url.includes('sesp.')) return 'oficial';
  if (url.includes('sosdesaparecidos') || url.includes('desaparecidos.org') || url.includes('childhood') || url.includes('abducted')) return 'ong';
  if (url.includes('g1.') || url.includes('uol.') || url.includes('r7.') || url.includes('band.') || url.includes('folha.') || url.includes('estadao.') || url.includes('correiodopovo') || url.includes('gazetadopovo') || url.includes('clicrbs')) return 'midia';
  if (url.includes('facebook') || url.includes('instagram') || url.includes('twitter') || url.includes('tiktok') || url.includes('youtube')) return 'social';
  return 'web';
}

// ── Validar relevância da fonte ───────────────────
// Só aceita fonte se mencionar o nome da pessoa
function fonteRelevante(resultado, nome) {
  const nomePartes = nome.toLowerCase().split(' ').filter(p => p.length > 2);
  const texto = (resultado.title + ' ' + resultado.content).toLowerCase();
  // Pelo menos 2 partes do nome devem aparecer
  const matches = nomePartes.filter(p => texto.includes(p));
  return matches.length >= Math.min(2, nomePartes.length);
}

// ── Detectar se é cold case ───────────────────────
function detectarModo(dataStr) {
  try {
    const partes = dataStr.replace(/\//g, '-').split('-');
    let data;
    if (partes[0].length === 4) {
      data = new Date(dataStr);
    } else {
      data = new Date(`${partes[2]}-${partes[1]}-${partes[0]}`);
    }
    const diasDesde = Math.floor((Date.now() - data.getTime()) / 86400000);
    if (diasDesde <= 30) return { modo: 'ativo', dias: diasDesde };
    if (diasDesde <= 365) return { modo: 'recente', dias: diasDesde };
    return { modo: 'cold_case', dias: diasDesde, anos: Math.floor(diasDesde / 365) };
  } catch (e) {
    return { modo: 'ativo', dias: 0 };
  }
}

// ── Coletar fontes sobre o caso ───────────────────
async function coletarFontesCaso(nome, cidade, data, modo) {
  const primeiroNome = nome.split(' ')[0];
  const estado = cidade.includes(',') ? cidade.split(',')[1].trim() : cidade;

  const queries = [
    `"${nome}" desaparecido ${cidade}`,
    `"${nome}" desaparecimento ${estado}`,
    `"${primeiroNome}" desaparecido ${cidade} site:g1.globo.com OR site:uol.com.br OR site:r7.com`,
    `"${nome}" site:pc.pr.gov.br OR site:policiacivil.rs.gov.br OR site:ssp.sp.gov.br OR site:gov.br`,
    `"${nome}" desaparecido site:sosdesaparecidos.com.br OR site:desaparecidos.org.br`,
  ];

  if (modo.modo === 'cold_case') {
    queries.push(`"${nome}" encontrado localizado`);
    queries.push(`"${nome}" ossos corpo identificado`);
  }

  const todas = [];
  const urlsVistas = new Set();

  for (const q of queries) {
    const res = await tavily(q, 4);
    for (const r of res) {
      if (!urlsVistas.has(r.url) && fonteRelevante(r, nome)) {
        urlsVistas.add(r.url);
        todas.push({
          titulo: r.title || '',
          url: r.url || '',
          conteudo: (r.content || '').slice(0, 600),
          fonte: classificarFonte(r.url)
        });
      }
    }
  }

  return todas.slice(0, 12);
}

// ── Buscar casos com desfecho positivo ────────────
async function buscarCasosPositivos(d, modo) {
  const perfil = [
    d.sexo || '',
    d.idade ? `${d.idade}` : '',
    d.cidade?.split(',')[1]?.trim() || 'Brasil'
  ].filter(Boolean).join(' ');

  const queries = [
    `desaparecido encontrado vivo ${perfil} Brasil`,
    `pessoa desaparecida localizada ${d.cidade?.split(',')[1]?.trim() || 'Brasil'} família`,
    `desaparecido reencontrado família Brasil ${d.sexo || ''}`,
  ];

  if (modo.modo === 'cold_case') {
    queries.push(`cold case resolvido desaparecido encontrado anos depois Brasil`);
  }

  const PALAVRAS_POSITIVAS = ['encontrado', 'localizado', 'reencontrado', 'retornou', 'vivo', 'são e salvo', 'retornado', 'apareceu'];
  const PALAVRAS_NEGATIVAS = ['corpo', 'morto', 'falecido', 'ossada', 'assassinado', 'vítima', 'homicídio', 'feminicídio'];

  const casos = [];
  const urlsVistas = new Set();

  for (const q of queries) {
    const res = await tavily(q, 5);
    for (const r of res) {
      if (urlsVistas.has(r.url)) continue;
      const texto = (r.title + ' ' + r.content).toLowerCase();
      const temPositivo = PALAVRAS_POSITIVAS.some(p => texto.includes(p));
      const temNegativo = PALAVRAS_NEGATIVAS.some(p => texto.includes(p));
      if (temPositivo && !temNegativo) {
        urlsVistas.add(r.url);
        casos.push({
          titulo: r.title || '',
          url: r.url || '',
          conteudo: (r.content || '').slice(0, 400),
          fonte: classificarFonte(r.url)
        });
      }
    }
  }

  return casos.slice(0, 6);
}

// ── Build prompt principal ────────────────────────
function buildPrompt(d, fontes, modo) {
  const modoTxt = {
    ativo: 'BUSCA ATIVA (desaparecimento recente — foco em ação imediata)',
    recente: 'CASO RECENTE (1–12 meses — foco em investigação e rastros)',
    cold_case: `COLD CASE (${modo.anos || '1+'} anos — foco em quem a pessoa se tornou e padrões da época)`
  }[modo.modo];

  const secaoFontes = fontes.length > 0
    ? `\nFONTES ENCONTRADAS NA WEB (${fontes.length} resultados com nome confirmado):\n` +
      fontes.map((r, i) => `[${i+1}] [${r.fonte.toUpperCase()}] ${r.titulo}\nURL: ${r.url}\nConteúdo: ${r.conteudo}`).join('\n\n')
    : '\nNenhuma fonte encontrada na web com o nome desta pessoa.';

  const instrucoesModo = {
    ativo: `
FOCO DO MODO ATIVO:
- Orientações práticas para as PRÓXIMAS 24-48 HORAS
- O que a família deve fazer AGORA (Disque 100, delegacia, redes sociais, cartaz)
- Locais de busca imediata baseados no último avistamento
- O que NÃO fazer (não limpar o quarto, não apagar mensagens do celular)
- Hipóteses baseadas no perfil e contexto fornecido`,

    recente: `
FOCO DO MODO RECENTE:
- Rastros digitais que ainda podem existir (câmeras, celular, redes sociais)
- Investigação de círculo social próximo
- Padrões de casos similares não resolvidos na região
- O que pode ter sido perdido nas primeiras semanas`,

    cold_case: `
FOCO DO COLD CASE:
- Quem a pessoa seria hoje (idade atual, aparência provável)
- Cruzamento com registros civis posteriores ao desaparecimento
- Técnicas de investigação para casos antigos (DNA, registros hospitalares, CPF emitido após data)
- Padrões de crimes da época na região que foram resolvidos
- NÃO sugerir "buscar no local" — o foco é investigação de registros e identidade atual`
  }[modo.modo];

  return [
    `Você é um analista sênior de investigação de desaparecimentos. Sua análise deve ser específica, útil e responsável.`,
    `Responda APENAS com JSON puro e válido, sem texto antes ou depois, sem markdown.`,
    ``,
    `MODO: ${modoTxt}`,
    instrucoesModo,
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
    d.contexto ? `- Contexto de vida: ${d.contexto}` : null,
    d.feito    ? `- O que já foi feito: ${d.feito}` : null,
    secaoFontes,
    ``,
    `REGRAS CRÍTICAS:`,
    `1. Só mencione fontes que confirmem o nome desta pessoa especificamente`,
    `2. NUNCA vincule notícias de outras pessoas ao caso — verifique sempre o nome`,
    `3. Divergências: só aponte se houver contradição real entre fontes sobre ESTE caso`,
    `4. Hipóteses: seja específico para este perfil, não genérico`,
    `5. Para a família: linguagem humana, empática, focada em ação — SEM alarmismo`,
    `6. Para investigadores: técnico, direto, com os cenários reais inclusive os difíceis`,
    ``,
    `Responda com este JSON exato:`,
    `{`,
    `  "modo": "${modo.modo}",`,
    `  "resumo": "string — 2-3 frases objetivas sobre o caso",`,
    `  "urgencia": "alta|media|baixa",`,
    `  "urgencia_motivo": "string",`,
    `  "divergencias": [{"descricao":"string neutro","fonte_a":"string","fonte_b":"string"}],`,
    `  "fontes_confirmadas": [{"titulo":"string","url":"string","tipo":"oficial|midia|ong|social|web","relevancia":"alta|media|baixa"}],`,
    `  "para_familia": {`,
    `    "mensagem_inicial": "string — mensagem humana e empática para abrir esta seção",`,
    `    "acoes_imediatas": ["string — ação prática e específica"],`,
    `    "o_que_nao_fazer": ["string — erros comuns que atrapalham a busca"],`,
    `    "contatos_uteis": ["string — órgão + número ou site específico"],`,
    `    "locais_busca": {"imediato":["string"],"secundario":["string"],"digital":["string"]}`,
    `  },`,
    `  "para_investigadores": {`,
    `    "hipoteses": [{"titulo":"string","probabilidade":"alta|media|baixa","descricao":"string baseado em dados reais","indicadores":["string"]}],`,
    `    "timeline": [{"data":"string","titulo":"string","descricao":"string","cor":"red|amber|green|gray"}],`,
    `    "pontos_criticos": ["string — informação técnica relevante para investigação"],`,
    `    "checklist": ["string — verificação específica que deve ser feita"]`,
    `  },`,
    `  "alertas": ["string — apenas alertas críticos reais, não óbvios"]`,
    `}`,
    ``,
    `Produza 3-5 hipóteses. Divergências pode ser [] se não houver. Seja específico e útil.`
  ].filter(Boolean).join('\n');
}

// ── Build prompt casos positivos ──────────────────
function buildPromptCasosPositivos(d, casosRaw, modo) {
  return [
    `Você é um especialista em casos de desaparecidos. Com base nos resultados abaixo, selecione e resuma até 5 casos com DESFECHO POSITIVO (pessoa encontrada viva) que sejam de alguma forma similares ao perfil descrito.`,
    `Responda APENAS com JSON puro, sem markdown.`,
    ``,
    `PERFIL DO CASO ATUAL:`,
    `- Nome: ${d.nome} | Cidade: ${d.cidade} | Data: ${d.data}`,
    d.idade ? `- Idade: ${d.idade}` : null,
    d.sexo  ? `- Sexo: ${d.sexo}` : null,
    `- Modo: ${modo.modo}`,
    ``,
    `RESULTADOS DA BUSCA (${casosRaw.length} encontrados):`,
    casosRaw.map((r, i) => `[${i+1}] ${r.titulo}\n${r.conteudo}`).join('\n\n'),
    ``,
    `REGRAS:`,
    `1. Inclua APENAS casos onde a pessoa foi encontrada viva`,
    `2. Exclua casos de corpos encontrados, morte confirmada ou sem desfecho positivo`,
    `3. Se não houver casos positivos claros, retorne array vazio`,
    `4. Seja breve e esperançoso na descrição`,
    ``,
    `Responda com:`,
    `{`,
    `  "casos": [`,
    `    {`,
    `      "titulo": "string — nome/descrição do caso",`,
    `      "desfecho": "string — como foi encontrado/o que funcionou",`,
    `      "licao": "string — o que pode ser útil para famílias em situação similar",`,
    `      "url": "string — URL da fonte",`,
    `      "tempo_desaparecido": "string — quanto tempo ficou desaparecido"`,
    `    }`,
    `  ]`,
    `}`
  ].filter(Boolean).join('\n');
}

// ── Chamar Groq ───────────────────────────────────
async function chamarGroq(prompt, maxTokens = 4000) {
  const body = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: 'Você é um analista especializado em investigação de desaparecimentos. Responda SEMPRE com JSON puro e válido, sem texto adicional, sem markdown, sem blocos de código.'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.25,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' }
  });

  const res = await httpPost('api.groq.com', '/openai/v1/chat/completions', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
  }, body);

  if (res.error) throw new Error(res.error.message);
  const text = res.choices?.[0]?.message?.content || '';
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(clean);
}

// ── Handler principal ─────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checarRateLimit(ip)) return res.status(429).json({ error: 'Limite diário atingido. Tente amanhã.' });

  const d = req.body || {};
  if (!d.nome || !d.cidade || !d.data) return res.status(400).json({ error: 'Nome, cidade e data são obrigatórios.' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY não configurada.' });
  if (!process.env.TAVILY_API_KEY) return res.status(500).json({ error: 'TAVILY_API_KEY não configurada.' });

  try {
    const modo = detectarModo(d.data);

    // Busca em paralelo — fontes do caso + casos positivos
    const [fontesCaso, casosPositivosRaw] = await Promise.all([
      coletarFontesCaso(d.nome, d.cidade, d.data, modo),
      buscarCasosPositivos(d, modo)
    ]);

    // Análise principal + casos positivos em paralelo
    const [analise, casosPositivos] = await Promise.all([
      chamarGroq(buildPrompt(d, fontesCaso, modo), 4000),
      casosPositivosRaw.length > 0
        ? chamarGroq(buildPromptCasosPositivos(d, casosPositivosRaw, modo), 2000)
        : Promise.resolve({ casos: [] })
    ]);

    return res.status(200).json({
      ...analise,
      modo: modo.modo,
      dias_desaparecido: modo.dias,
      anos_desaparecido: modo.anos,
      total_fontes: fontesCaso.length,
      casos_positivos: casosPositivos.casos || []
    });

  } catch (err) {
    console.error('Erro:', err);
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
};
