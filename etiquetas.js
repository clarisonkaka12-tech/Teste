/* FotoLocalizador — etiquetas.js (v11)
   Leitura de etiquetas: um leitor (IA opcional ou arquivo .json) devolve uma LISTA de itens; todos passam por validar() e pela
   tela de conferência. Nada é salvo sem o usuário ver. Usa as funções do app.js (S, cur, h, $, put…), sem alterá-las. */
"use strict";
(() => {
/* ---------- mapeamento etiqueta → campos que o app já tinha (fácil de mudar) ---------- */
const ETIQUETA_MAP = {
  code: i => i.pa,
  name: i => [i.cliente, i.codCliente].filter(Boolean).join(" · ") || (i.pa ? "Etiqueta " + i.pa : "Etiqueta"),
  desc: i => i.descricao,
  notes: i => [i.lote && "Lote " + i.lote, i.qtd && "Qtd " + i.qtd, i.dataEtiq && "Data " + i.dataEtiq.split("-").reverse().join("/")].filter(Boolean).join(" · "),
  tags: i => i.saldo ? ["SALDO"] : []
};
const CLIENTES = ["HONDA", "HONDA AUTO", "VW CURITIBA", "ZF SOROCABA", "VOLVO", "SCANIA", "BORGWARNER", "STIHL", "CUMMINS", "KRUPP"];
const CAMPOS = { cliente: "Cliente", codCliente: "Cód. cliente", descricao: "Descrição", pa: "PA", qtd: "Qtd", dataEtiq: "Data", lote: "Lote" };
const ALIAS = { data: "dataEtiq", dataetiq: "dataEtiq", desc: "descricao" };

/* ---------- 4. VALIDAÇÃO (sem DOM). Falhou = amarelo; nunca descarta em silêncio ---------- */
const RE_PA = /^PA[A-Z0-9]{10}$/, RE_LOTE = /^\d[A-Z]\d{3}$/, RE_DESC = /^[A-Z0-9]{1,5} M\d{1,2}x\d+(,\d+)?x\d+(,\d+)?$/;
const D2L = { O: "0", Q: "0", I: "1", L: "1", S: "5", B: "8", Z: "2" }, L2D = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z" };
const T = v => v == null ? "" : String(v).replace(/\s+/g, " ").trim();
const pad = n => String(n).padStart(2, "0");
function parseData(v) { /* dd/mm/aa, dd/mm/aaaa ou aaaa-mm-dd → ISO; inexistente → "" */
  const t = T(v); if (!t) return "";
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/), y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else { m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/); if (!m) return ""; d = +m[1]; mo = +m[2]; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
  return y + "-" + pad(mo) + "-" + pad(d);
}
function normLote(raw) { /* O↔0, I↔1, S↔5, B↔8 só nas posições em que o padrão exige dígito/letra */
  const t = T(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (RE_LOTE.test(t) || t.length !== 5) return { v: t };
  const c = [...t].map((ch, i) => i === 1 ? (L2D[ch] || ch) : (D2L[ch] || ch)).join("");
  return RE_LOTE.test(c) ? { v: c, de: t } : { v: t };
}
function normDesc(raw) { return T(raw).toUpperCase().replace(/\./g, ",").replace(/(\d)X(?=\d)/g, "$1x"); }
const dist1 = (a, b) => { /* distância de edição ≤ 1 ? */
  if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};
/* 5. memória de PA: dicionário montado em memória a partir das marcações já salvas (sem store nova) */
function memoria() {
  const pa = new Map(), cli = new Set(CLIENTES);
  for (const a of S.anns) { if (a.cliente) cli.add(a.cliente.toUpperCase()); if (a.pa && !pa.has(a.pa)) pa.set(a.pa, a); }
  return { pa, cli };
}
function validar(raw, mem = memoria()) {
  const am = [], add = (campo, motivo) => { if (!am.some(x => x.campo === campo)) am.push({ campo, motivo }); };
  const it = {
    cliente: T(raw.cliente).toUpperCase(), codCliente: T(raw.codCliente), descricao: normDesc(raw.descricao),
    pa: T(raw.pa).toUpperCase().replace(/\s/g, ""), qtd: +raw.qtd > 0 ? Math.trunc(+raw.qtd) : "",
    dataEtiq: parseData(raw.dataEtiq != null ? raw.dataEtiq : raw.data), lote: "", saldo: !!raw.saldo, barras: T(raw.barras),
    caixa: raw.caixa, cortada: !!raw.cortada, sug: null
  };
  const L = normLote(raw.lote); it.lote = L.v;
  const m = mem.pa.get(it.pa);
  if (m) { /* PA já conhecido: completa o que faltou */
    if (!it.cliente) it.cliente = m.cliente; if (!it.codCliente) it.codCliente = m.codCliente; if (!it.descricao) it.descricao = m.desc;
  } else if (RE_PA.test(it.pa)) { for (const k of mem.pa.keys()) if (dist1(it.pa, k)) { it.sug = { campo: "pa", valor: k }; break; } }
  if (!it.pa) add("pa", "PA não lido"); else if (!RE_PA.test(it.pa)) add("pa", "PA fora do padrão (PA + 10 caracteres)");
  if (it.sug) add("pa", "PA parecido com um já salvo: " + it.sug.valor);
  if (!it.lote) add("lote", "lote não lido"); else if (L.de) add("lote", "corrigido de " + L.de + " — confira"); else if (!RE_LOTE.test(it.lote)) add("lote", "lote fora do padrão");
  if (!it.qtd) add("qtd", "quantidade não lida ou zero");
  const dt = it.dataEtiq, dias = dt ? (Date.parse(dt) - Date.now()) / 864e5 : 0;
  if (!dt) add("dataEtiq", T(raw.dataEtiq != null ? raw.dataEtiq : raw.data) ? "data inválida" : "data não lida");
  else if (dias > 7 || dias < -730) add("dataEtiq", "data fora do esperado");
  if (!it.descricao) add("descricao", "descrição não lida"); else if (!RE_DESC.test(it.descricao)) add("descricao", "descrição fora do padrão");
  if (!it.cliente) add("cliente", "cliente não lido"); else if (!mem.cli.has(it.cliente)) add("cliente", "cliente não conhecido (pode ser novo)");
  if (!it.codCliente) add("codCliente", "código do cliente não lido");
  if (it.cortada) for (const c of ["cliente", "codCliente", "descricao"]) add(c, "etiqueta cortada na borda da foto");
  for (const d of Array.isArray(raw.duvidas) ? raw.duvidas : []) { const c = ALIAS[String(d).toLowerCase()] || d; if (CAMPOS[c]) add(c, "leitura incerta"); }
  const conf = Math.max(0, Math.min(1, (+raw.confianca > 0 ? +raw.confianca : 0.9) - 0.08 * am.length));
  return { item: it, amarelos: am, conf };
}

/* ---------- 2. FORMATO fotolocalizador-etiquetas v1 (importação e resposta da IA) ---------- */
function normCaixa(c, estrito, i) {
  const n = ["x", "y", "w", "h"].map(k => c && c[k]);
  if (!n.every(v => typeof v === "number" && isFinite(v))) throw new Error("item " + (i + 1) + ": caixa inválida");
  let [x, y, w, hh] = n;
  if (estrito && (x < 0 || y < 0 || w <= 0 || hh <= 0 || x + w > 1.001 || y + hh > 1.001)) throw new Error("item " + (i + 1) + ": caixa fora da foto (use valores de 0 a 1)");
  x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y)); w = Math.max(0, Math.min(1 - x, w)); hh = Math.max(0, Math.min(1 - y, hh));
  return w < 0.02 || hh < 0.02 ? null : { x, y, w, h: hh };
}
function lerFormato(o, estrito) {
  if (!o || o.format !== "fotolocalizador-etiquetas") throw new Error("Este arquivo não é do formato “fotolocalizador-etiquetas”.");
  if (o.version !== 1) throw new Error("Versão " + o.version + " do arquivo não é suportada (este app lê a versão 1).");
  if (!Array.isArray(o.itens)) throw new Error("O arquivo não tem a lista “itens”.");
  const out = []; let pulados = 0;
  o.itens.forEach((r, i) => { const c = normCaixa(r && r.caixa, estrito, i); if (c) out.push({ ...r, caixa: c }); else pulados++; });
  return { itens: out, pulados };
}
function ordenar(lista) { /* ordem de leitura: fileiras de cima para baixo, da esquerda para a direita */
  const v = lista.slice().sort((a, b) => (a.caixa.y + a.caixa.h / 2) - (b.caixa.y + b.caixa.h / 2));
  const alt = v.length ? v.map(i => i.caixa.h).sort((a, b) => a - b)[v.length >> 1] : 0, rows = [];
  for (const i of v) { const yc = i.caixa.y + i.caixa.h / 2, r = rows.find(r => Math.abs(r.yc - yc) < alt * 0.5); if (r) { r.l.push(i); r.yc = (r.yc * (r.l.length - 1) + yc) / r.l.length; } else rows.push({ yc, l: [i] }); }
  return rows.sort((a, b) => a.yc - b.yc).flatMap(r => r.l.sort((a, b) => a.caixa.x - b.caixa.x));
}
const iou = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), hh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || hh <= 0) return 0; const i = w * hh; return i / (a.w * a.h + b.w * b.h - i);
};

/* ---------- leitores ---------- */
function encolher(blob, max = 2000) { /* a foto vai ao servidor reduzida (limite de 4,5 MB da Vercel) */
  return createImageBitmap(blob).then(bm => {
    const k = Math.min(1, max / Math.max(bm.width, bm.height)), c = document.createElement("canvas");
    c.width = Math.round(bm.width * k); c.height = Math.round(bm.height * k); c.getContext("2d").drawImage(bm, 0, 0, c.width, c.height); bm.close();
    return new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error("não foi possível preparar a foto")), "image/jpeg", 0.88));
  });
}
const b64 = blob => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
const getSenha = () => { try { return localStorage.getItem("fl_senha") || ""; } catch (e) { return ""; } };
async function lerComIA(photo, sinal, senha) {
  await withBlob(photo);
  const img = await encolher(photo.blob), corpo = JSON.stringify({ imagem: await b64(img), tipo: "image/jpeg" });
  let r;
  try { r = await fetch("/api/ler-etiquetas", { method: "POST", headers: { "content-type": "application/json", "x-senha": senha || getSenha() }, body: corpo, signal: sinal }); }
  catch (e) { if (e.name === "AbortError") throw e; throw new Error("sem conexão com o servidor (a leitura por IA precisa de internet)"); }
  let j = null; try { j = await r.json(); } catch (e) { /* resposta sem JSON */ }
  if (r.status === 401) { const s = await ask("Senha da leitura", { msg: "Digite a senha configurada na Vercel (LEITURA_SENHA).", label: "Senha", ok: "Entrar" }); if (!s) throw new Error("senha não informada"); try { localStorage.setItem("fl_senha", s); } catch (e) { /* sem armazenamento */ } return lerComIA(photo, sinal, s); }
  if (r.status === 404) throw new Error("a leitura por IA só funciona no app publicado na Vercel (pasta api/ incluída)");
  if (!r.ok) throw new Error((j && j.erro) || "o servidor respondeu com erro " + r.status);
  return lerFormato(j, false);
}

/* ---------- interface: escolha, progresso, conferência ---------- */
function escolher() {
  return new Promise(res => {
    const d = $("#dlg"), f = $("#dlgbody"), done = v => { d.close(); res(v); };
    f.replaceChildren(h("h3", {}, "Ler etiquetas desta foto"),
      h("p", { class: "mut" }, "Nada é salvo antes de você conferir."),
      h("div", { class: "col" },
        h("button", { type: "button", class: "pri", onclick: () => done("ia") }, "Ler com IA (envia a foto)"),
        h("button", { type: "button", onclick: () => done("arquivo") }, "Importar arquivo de marcações (.json)"),
        h("button", { type: "button", disabled: true }, "Leitura local (OCR) — não instalado"),
        h("button", { type: "button", class: "ghost", onclick: () => done(null) }, "Cancelar")));
    d.oncancel = () => res(null); d.showModal();
  });
}
function progresso(texto, aoCancelar) {
  const box = h("div", { class: "etprog", role: "status", "aria-live": "polite" }, h("p", {}, texto), h("div", { class: "etbar" }, h("i", {})),
    h("button", { type: "button", onclick: aoCancelar }, "Cancelar"));
  document.body.append(box); return { close: () => box.remove() };
}
let undoT;
function barraDesfazer(txt, aoDesfazer) {
  document.querySelectorAll(".etundo").forEach(e => e.remove()); clearTimeout(undoT);
  const b = h("div", { class: "etundo", role: "status" }, h("span", {}, txt), h("button", { type: "button", onclick: async () => { b.remove(); await aoDesfazer(); } }, "Desfazer"));
  document.body.append(b); undoT = setTimeout(() => b.remove(), 15000);
}

async function conferir(photo, itens, leitor) {
  await withBlob(photo);
  const mem = memoria(), exist = S.anns.filter(a => a.photo === photo.id);
  const L = ordenar(itens).map((r, k) => {
    const v = validar(r, mem), cx = { ...r.caixa };
    let dup = "";
    for (const a of exist) { if (v.item.pa && a.pa === v.item.pa && a.lote === v.item.lote) { dup = "já existe uma marcação com este PA e lote"; break; } if (iou(a, cx) > 0.5) { dup = "já existe uma marcação neste lugar"; break; } }
    return { n: k + 1, v: v.item, am: v.amarelos, conf: v.conf, cx, dup, inc: !dup && !v.amarelos.length };
  });
  const root = h("div", { class: "conf", role: "dialog", "aria-modal": "true", "aria-label": "Conferir etiquetas" });
  const cnt = h("span", { class: "mut", "aria-live": "polite" }), layer = h("div", { class: "cl" }), list = h("div", { class: "clist" });
  const btnSalvar = h("button", { type: "button", class: "pri" }), rects = new Map(), cards = new Map();
  const fechar = () => { root.remove(); document.body.classList.remove("etopen"); };
  const conta = () => {
    const n = L.filter(i => i.inc).length, y = L.filter(i => i.am.length).length;
    cnt.textContent = L.length + " etiqueta(s) · " + y + " com alerta · " + n + " para salvar";
    btnSalvar.textContent = "Salvar " + n + " marcação(ões)"; btnSalvar.disabled = !n;
    for (const i of L) { const r = rects.get(i.n), c = cards.get(i.n); r.className = "crect " + (i.dup && !i.inc ? "dup" : i.am.length ? "warn" + (i.inc ? "" : " skip") : i.inc ? "ok" : "out"); c.classList.toggle("off", !i.inc); c.querySelector(".tg").textContent = i.inc ? "✓ Incluir" : "Pular"; c.querySelector(".tg").setAttribute("aria-pressed", String(i.inc)); }
  };
  const foco = n => { for (const [k, c] of cards) c.classList.toggle("foco", k === n); for (const [k, r] of rects) r.classList.toggle("sel", k === n); cards.get(n).scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  const campo = (i, k, tipo) => {
    const a = i.am.find(x => x.campo === k), val = k === "dataEtiq" || k === "qtd" ? i.v[k] : i.v[k];
    const inp = h("input", { "aria-label": CAMPOS[k] + " da etiqueta " + i.n, type: tipo || "text", inputmode: k === "qtd" ? "numeric" : null, class: a ? "warn" : "" });
    inp.value = val; const nota = h("small", { class: "why" }, a ? a.motivo : "");
    inp.addEventListener("input", () => {
      const v = inp.value; i.v[k] = k === "qtd" ? (+v > 0 ? Math.trunc(+v) : "") : (k === "pa" || k === "lote" || k === "cliente") ? v.toUpperCase() : v;
      i.am = i.am.filter(x => x.campo !== k); inp.classList.remove("warn"); nota.textContent = ""; if (!i.am.length && !i.dup) i.inc = true; conta();
    });
    const sug = k === "pa" && i.v.sug ? h("button", { type: "button", class: "mini", onclick: () => { i.v.pa = i.v.sug.valor; inp.value = i.v.pa; i.am = i.am.filter(x => x.campo !== "pa"); inp.classList.remove("warn"); nota.textContent = ""; i.v.sug = null; conta(); } }, "Usar " + i.v.sug.valor) : null;
    return h("div", { class: "cf cf-" + k }, h("label", {}, CAMPOS[k]), inp, nota, sug);
  };
  for (const i of L) {
    const r = h("div", { class: "crect", style: `left:${i.cx.x * 100}%;top:${i.cx.y * 100}%;width:${i.cx.w * 100}%;height:${i.cx.h * 100}%` }, h("b", {}, String(i.n)), h("i", { class: "hdl" }));
    r.addEventListener("pointerdown", ev => { /* mover / redimensionar o retângulo da caixa */
      ev.preventDefault(); foco(i.n); r.setPointerCapture(ev.pointerId);
      const box = layer.getBoundingClientRect(), p0 = { x: ev.clientX, y: ev.clientY }, o = { ...i.cx }, rs = ev.target.classList.contains("hdl");
      const mv = e => {
        const dx = (e.clientX - p0.x) / box.width, dy = (e.clientY - p0.y) / box.height;
        if (rs) { i.cx.w = Math.max(0.02, Math.min(1 - o.x, o.w + dx)); i.cx.h = Math.max(0.02, Math.min(1 - o.y, o.h + dy)); }
        else { i.cx.x = Math.max(0, Math.min(1 - o.w, o.x + dx)); i.cx.y = Math.max(0, Math.min(1 - o.h, o.y + dy)); }
        r.style.left = i.cx.x * 100 + "%"; r.style.top = i.cx.y * 100 + "%"; r.style.width = i.cx.w * 100 + "%"; r.style.height = i.cx.h * 100 + "%";
      };
      const up = () => { r.removeEventListener("pointermove", mv); r.removeEventListener("pointerup", up); r.removeEventListener("pointercancel", up); };
      r.addEventListener("pointermove", mv); r.addEventListener("pointerup", up); r.addEventListener("pointercancel", up);
    });
    rects.set(i.n, r); layer.append(r);
    const tg = h("button", { type: "button", class: "tg", onclick: () => { i.inc = !i.inc; conta(); } });
    const c = h("article", { class: "ccard" },
      h("header", {}, h("b", { class: "num" }, String(i.n)), h("span", { class: "tt" }, [i.v.cliente, i.v.pa].filter(Boolean).join(" · ") || "Etiqueta " + i.n), h("span", { class: "mut" }, Math.round(i.conf * 100) + "%"), tg),
      i.dup ? h("p", { class: "dupmsg" }, "⚠ " + i.dup + " — por padrão será pulada.") : null,
      i.v.cortada ? h("p", { class: "dupmsg" }, "⚠ etiqueta cortada na borda da foto.") : null,
      h("div", { class: "cgrid" }, campo(i, "cliente"), campo(i, "codCliente"), campo(i, "descricao"), campo(i, "pa"), campo(i, "qtd", "number"), campo(i, "dataEtiq", "date"), campo(i, "lote")),
      h("label", { class: "chk" }, h("input", { type: "checkbox", checked: i.v.saldo, onchange: e => { i.v.saldo = e.target.checked; } }), " Selo SALDO"));
    c.addEventListener("focusin", () => foco(i.n)); cards.set(i.n, c); list.append(c);
  }
  btnSalvar.onclick = async () => {
    const sel = L.filter(i => i.inc); if (!sel.length) return;
    btnSalvar.disabled = true; const t0 = Date.now();
    const novas = sel.map((i, k) => {
      const v = i.v, a = fixAnn({
        id: uid(), photo: photo.id, tab: photo.tab, name: ETIQUETA_MAP.name(v), code: ETIQUETA_MAP.code(v), desc: ETIQUETA_MAP.desc(v), notes: "", tags: ETIQUETA_MAP.tags(v), status: "ativo",
        x: i.cx.x, y: i.cx.y, w: i.cx.w, h: i.cx.h, hidden: false, created: new Date(t0 + k).toISOString(), updated: new Date(t0 + k).toISOString(), hist: [], /* created crescente = ordem de leitura */
        pa: v.pa, lote: v.lote, qtd: v.qtd, dataEtiq: v.dataEtiq, cliente: v.cliente, codCliente: v.codCliente, barras: v.barras, fonte: "etiqueta",
        leitura: { conf: Math.round(i.conf * 100) / 100, amarelos: i.am.map(x => x.campo), leitor }
      });
      a.notes = ETIQUETA_MAP.notes(a); return a;
    });
    try { await putMany("anns", novas); } catch (e) { btnSalvar.disabled = false; return; } /* putMany já mostra o erro; nada foi gravado */
    S.anns.push(...novas); fechar(); cur.sel = null; renderAll();
    toast(novas.length + " marcação(ões) criada(s)");
    barraDesfazer(novas.length + " marcação(ões) salva(s).", async () => {
      const ids = new Set(novas.map(a => a.id));
      try { await delMany([...ids].map(id => ["anns", id])); } catch (e) { return; }
      S.anns = S.anns.filter(a => !ids.has(a.id)); if (ids.has(cur.sel)) cur.sel = null; renderAll(); toast("Lote desfeito");
    });
  };
  const todosVerdes = h("button", { type: "button", onclick: () => { for (const i of L) if (!i.am.length && !i.dup) i.inc = true; conta(); } }, "Aceitar todos sem alerta");
  const amarelos = h("button", { type: "button", onclick: () => { const i = L.find(x => x.am.length && !x.inc) || L.find(x => x.am.length); if (i) foco(i.n); else toast("Nenhum alerta para revisar"); } }, "Revisar amarelos");
  const img = h("img", { alt: "Foto com as caixas detectadas", draggable: "false", src: url(photo) });
  root.append(
    h("header", { class: "chead" }, h("h2", {}, "Conferir etiquetas"), cnt, h("button", { type: "button", class: "ghost", onclick: async () => { if (!L.some(i => i.inc) || await ask("Sair sem salvar?", { msg: "A leitura será descartada.", ok: "Sair", danger: true })) fechar(); } }, "✕")),
    h("div", { class: "cthumb" }, h("div", { class: "cwrap" }, img, layer)),
    h("div", { class: "cbar" }, todosVerdes, amarelos),
    list, h("footer", { class: "cfoot" }, btnSalvar));
  document.body.append(root); document.body.classList.add("etopen"); conta();
}

/* ---------- ponto de entrada: botão “Ler etiquetas” ---------- */
let ocupado = false;
async function iniciar() {
  const p = curPhoto(); if (!p) { toast("Abra uma foto primeiro.", true); return; }
  if (ocupado || !(await guard())) return;
  const modo = await escolher(); if (!modo) return;
  ocupado = true;
  try {
    if (modo === "arquivo") {
      const f = h("input", { type: "file", accept: "application/json,.json" });
      const file = await new Promise(ok => { f.onchange = () => ok(f.files[0] || null); f.addEventListener("cancel", () => ok(null)); f.click(); });
      if (!file) return;
      let o; try { o = JSON.parse(await file.text()); } catch (e) { throw new Error("o arquivo não é um JSON válido"); }
      const r = lerFormato(o, true);
      if (!r.itens.length) throw new Error("o arquivo não tem etiquetas utilizáveis");
      if (r.pulados) toast(r.pulados + " item(ns) com caixa minúscula foram ignorados", true);
      await conferir(p, r.itens, "importacao");
    } else {
      if (!(await ask("Enviar esta foto para a IA?", { msg: "A foto (reduzida) será enviada pela internet ao serviço de IA da Anthropic, através do seu servidor na Vercel, só desta vez. Use apenas se isso for aceitável para as fotos do estoque. Pode levar de 10 a 40 segundos.", ok: "Enviar e ler" }))) return;
      const ac = new AbortController(), pr = progresso("Lendo etiquetas com IA…", () => ac.abort());
      let r; try { r = await lerComIA(p, ac.signal); } finally { pr.close(); }
      if (!r.itens.length) { toast("A IA não encontrou etiquetas nesta foto.", true); return; }
      await conferir(p, r.itens, "ia");
    }
  } catch (e) { if (e && e.name === "AbortError") toast("Leitura cancelada"); else toast("Não foi possível ler: " + msg(e), true); }
  finally { ocupado = false; }
}
$("#aRead").addEventListener("click", iniciar);
window.FLEtiquetas = { validar, lerFormato, ordenar, parseData, normLote, normDesc, iou }; /* usado nos testes */
})();
