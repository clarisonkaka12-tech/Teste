/* Função serverless da Vercel (OPCIONAL): lê as etiquetas de uma foto com IA de visão.
   Só funciona se a variável ANTHROPIC_API_KEY estiver configurada na Vercel. A chave NUNCA vai para o navegador.
   Variáveis: ANTHROPIC_API_KEY (obrigatória) · LEITURA_SENHA (recomendada) · ANTHROPIC_MODEL (opcional). */
const SISTEMA = `Você lê etiquetas de caixas de papelão de um estoque industrial (fornecedor METALAC) em fotos de prateleira.
Cada caixa tem UMA etiqueta branca. Layout da etiqueta, de cima para baixo: CLIENTE (maiúsculas, às vezes com cidade); CÓDIGO da peça do cliente; DESCRIÇÃO (família + medida, ex.: SEXF M8x1,25x18); "METALAC" + selo preto "SALDO" (nem todas têm); PA (código interno em fonte grande, começa com "PA", 12 caracteres, ex.: PA80088180JA); linha pequena com QTDE/QTY (fundo preto), DATA/DATE (dd/mm/aa) e CQ/QC (LOTE) (ex.: 6J885); código de barras.
Regras: (1) Devolva UM item por caixa visível, usando a ferramenta registrar_etiquetas. (2) "caixa" é o retângulo da FACE FRONTAL DE PAPELÃO inteira (não só a etiqueta), em coordenadas normalizadas 0..1 relativas à imagem toda: x,y = canto superior esquerdo; w,h = largura e altura. (3) NUNCA invente: se um campo estiver ilegível, cortado ou duvidoso, deixe vazio ("" ou 0) ou preencha e inclua o nome do campo em "duvidas". Atenção a 0/O, 1/I, 5/S, 8/B. (4) Etiqueta cortada na borda da foto: cortada=true. (5) Ignore manuscritos, carimbos e códigos soltos (CVT#02, SALDO impresso embaixo etc.), mas se um número manuscrito cobrir a quantidade, marque "qtd" em duvidas. (6) data no formato dd/mm/aa como impresso.`;
const FERRAMENTA = {
  name: "registrar_etiquetas", description: "Registra as etiquetas lidas na foto.",
  input_schema: { type: "object", required: ["itens"], properties: { itens: { type: "array", items: { type: "object", required: ["caixa", "pa"], properties: {
    caixa: { type: "object", required: ["x", "y", "w", "h"], properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } } },
    cliente: { type: "string" }, codCliente: { type: "string" }, descricao: { type: "string" }, pa: { type: "string" }, qtd: { type: "integer" },
    data: { type: "string" }, lote: { type: "string" }, saldo: { type: "boolean" }, barras: { type: "string" }, cortada: { type: "boolean" },
    duvidas: { type: "array", items: { type: "string", enum: ["cliente", "codCliente", "descricao", "pa", "qtd", "data", "lote"] } },
    confianca: { type: "number" } } } } } }
};
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return res.status(503).json({ erro: "Leitura por IA não configurada: falta a variável ANTHROPIC_API_KEY na Vercel." });
  if (process.env.LEITURA_SENHA && req.headers["x-senha"] !== process.env.LEITURA_SENHA) return res.status(401).json({ erro: "Senha incorreta." });
  const { imagem, tipo } = req.body || {};
  if (typeof imagem !== "string" || !["image/jpeg", "image/png", "image/webp"].includes(tipo)) return res.status(400).json({ erro: "Foto inválida." });
  if (imagem.length > 4_000_000) return res.status(413).json({ erro: "Foto grande demais (máx. ~3 MB depois de reduzida)." });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 8000, system: SISTEMA, tools: [FERRAMENTA], tool_choice: { type: "tool", name: "registrar_etiquetas" },
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: tipo, data: imagem } }, { type: "text", text: "Leia todas as etiquetas desta foto." }] }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ erro: "Erro no serviço de IA (" + r.status + "): " + ((j.error && j.error.message) || "sem detalhes") });
    const uso = (j.content || []).find(b => b.type === "tool_use");
    if (!uso || !uso.input || !Array.isArray(uso.input.itens)) return res.status(502).json({ erro: "A IA não devolveu a lista de etiquetas." });
    return res.status(200).json({ format: "fotolocalizador-etiquetas", version: 1, itens: uso.input.itens });
  } catch (e) { return res.status(500).json({ erro: "Falha ao consultar a IA: " + (e && e.message) }); }
};
