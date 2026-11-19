/* FotoLocalizador — app.js
   Índice:  1 Utilidades · 2 Banco de dados (IndexedDB) · 3 Estado · 4 Validação e backup (ZIP)
            5 Abas · 6 Endereço · 7 Fotos · 8 Visualizador e tela cheia · 9 Marcações (desenhar/mover)
            10 Editor e salvamento · 11 Pesquisa · 12 Lixeira · 13 Sistema (espaço, abas, offline)
            14 Ligações da interface · 15 Início */
"use strict";

/* ============================================================ 1. UTILIDADES */
const $ = s => document.querySelector(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const now = () => new Date().toISOString();
const fmt = iso => new Date(iso).toLocaleString("pt-BR");
const hhmm = () => new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const msg = e => (e && e.message) || String(e);

function h(tag, attrs, ...kids) { /* cria elementos sem innerHTML */
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}

let toastT;
function toast(text, err) {
  const t = $("#toast"); t.textContent = text; t.className = err ? "err" : ""; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, err ? 6000 : 3000);
}

/* qualquer erro inesperado aparece na tela (antes o botão simplesmente "não fazia nada") */
window.addEventListener("error", e => { const m = msg(e.error || e.message); if (/ResizeObserver/.test(m)) return; const t = $("#toast"); if (t.hidden || t.className !== "err") toast("Erro: " + m, true); });
window.addEventListener("unhandledrejection", e => { const t = $("#toast"); if (t.hidden || t.className !== "err") toast("Erro: " + msg(e.reason), true); });

function ask(title, o = {}) { /* diálogo: devolve texto/lista (com campos), true (confirmação) ou null (cancelou) */
  return new Promise(res => {
    const d = $("#dlg"), f = $("#dlgbody");
    f.replaceChildren(h("h3", {}, title), o.msg ? h("p", {}, o.msg) : null);
    const ins = (o.fields || (o.label ? [{ label: o.label, value: o.value }] : [])).map(x => {
      const i = h("input", { "aria-label": x.label, maxlength: 120, list: x.list || null, placeholder: x.ph || null });
      i.value = x.value || ""; f.append(h("label", {}, x.label), i); return i;
    });
    const done = v => { d.close(); res(v); };
    f.append(h("div", { class: "row", style: "margin-top:10px;justify-content:flex-end" },
      h("button", { type: "button", class: "ghost", onclick: () => done(null) }, "Cancelar"),
      h("button", { type: "button", class: o.danger ? "danger" : "pri", onclick: () => done(ins.length ? (o.fields ? ins.map(i => i.value.trim()) : (ins[0].value.trim() || null)) : true) }, o.ok || "OK")));
    f.onkeydown = e => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); f.querySelector("button:last-of-type").click(); } };
    d.oncancel = () => res(null);
    d.showModal(); if (ins[0]) ins[0].focus();
  });
}
$("#dlgbody").addEventListener("submit", e => e.preventDefault());

/* ============================================================ 2. BANCO DE DADOS (IndexedDB) */
const META = ["tabs", "photos", "anns"], STORES = [...META, "blobs", "trash"]; /* "blobs" guarda só o arquivo da foto, lido sob demanda */
const strip = (s, o) => { if (s === "photos" && o.blob) { const { blob, ...r } = o; return r; } return o; };
const bc = "BroadcastChannel" in window ? new BroadcastChannel("fotolocalizador") : null;
const pingOthers = () => { try { if (bc) bc.postMessage("w"); } catch (e) { /* aviso opcional */ } };
let db = null;
const rq = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const txDone = tx => new Promise((ok, no) => { /* só resolve quando o navegador CONFIRMOU a gravação */
  tx.oncomplete = () => { pingOthers(); ok(); };
  tx.onerror = () => no(tx.error);
  tx.onabort = () => no(tx.error || new Error("transação cancelada"));
});
const dbTx = (s, mode) => { if (!db) throw new Error("armazenamento local indisponível"); return db.transaction(s, mode); };
const failSave = e => toast("Erro ao salvar: " + (e && e.name === "QuotaExceededError" ? "armazenamento cheio" : msg(e)), true);

function openDB() {
  return new Promise((ok, no) => {
    const r = indexedDB.open("fotolocalizador", 3);
    r.onupgradeneeded = e => {
      const d = r.result, tx = r.transaction;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: "id" });
      if (e.oldVersion >= 1 && e.oldVersion < 2) { /* v1 → v2: move o arquivo de cada foto para "blobs" */
        const ph = tx.objectStore("photos"), bl = tx.objectStore("blobs");
        ph.openCursor().onsuccess = ev => { const c = ev.target.result; if (!c) return; const v = c.value; if (v.blob) { bl.put({ id: v.id, blob: v.blob }); delete v.blob; c.update(v); } c.continue(); };
      }
    };
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); ok(r.result); };
    r.onerror = () => no(r.error);
    r.onblocked = () => no(new Error("banco bloqueado por outra aba"));
  });
}
const dbAll = s => rq(dbTx(s).objectStore(s).getAll());
async function put(s, o) {
  try { const tx = dbTx(s, "readwrite"); tx.objectStore(s).put(strip(s, o)); await txDone(tx); }
  catch (e) { failSave(e); throw e; }
}
async function putMany(s, list) {
  try { const tx = dbTx(s, "readwrite"), st = tx.objectStore(s); list.forEach(o => st.put(strip(s, o))); await txDone(tx); }
  catch (e) { failSave(e); throw e; }
}
async function putPhoto(p) { /* metadados + arquivo na mesma transação */
  try {
    const { blob, ...m } = p, tx = dbTx(["photos", "blobs"], "readwrite");
    tx.objectStore("photos").put(m); tx.objectStore("blobs").put({ id: p.id, blob });
    await txDone(tx);
  } catch (e) { failSave(e); throw e; }
}
async function withBlob(p) {
  if (!p.blob) { const r = await rq(dbTx("blobs").objectStore("blobs").get(p.id)); if (!r || !r.blob) throw new Error("arquivo da foto não encontrado"); p.blob = r.blob; }
  return p;
}
async function delMany(ops, puts = []) { /* ops: [[store, id]]; puts: [[store, objeto]] — tudo numa transação: ou faz tudo ou nada */
  try {
    const tx = dbTx(STORES, "readwrite");
    puts.forEach(([s, o]) => tx.objectStore(s).put(o));
    ops.forEach(([s, id]) => tx.objectStore(s).delete(id));
    await txDone(tx);
  } catch (e) { toast("Erro ao excluir: " + msg(e), true); throw e; }
}

/* ============================================================ 3. ESTADO */
const S = { tabs: [], photos: [], anns: [], trash: [] };
const cur = { tab: null, photo: null, sel: null, zoom: 1, mode: null, dirty: false, fs: false, keepZoom: false };
const urls = {};
const url = p => urls[p.id] || (urls[p.id] = URL.createObjectURL(p.blob));
const EMPTY = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
const turl = p => { if (!p.thumb) return p.blob ? url(p) : EMPTY; const k = "t" + p.id; return urls[k] || (urls[k] = URL.createObjectURL(p.thumb)); };
const dropUrls = id => { for (const k of [id, "t" + id]) if (urls[k]) { URL.revokeObjectURL(urls[k]); delete urls[k]; } };
const byDate = (a, b) => a.created < b.created ? -1 : a.created > b.created ? 1 : 0;
const byOrder = (a, b) => ((a.order || 0) - (b.order || 0)) || byDate(a, b);
const LAYERS = ["Fileira da frente", "Fileira de trás", "Fileira 3", "Fileira final"];
function groupsOf(tab) {
  const m = new Map();
  for (const p of S.photos.filter(x => x.tab === tab).sort(byOrder)) { const k = p.loc || ""; if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
  return [...m].sort((a, b) => (a[0] === "") - (b[0] === "")).map(([loc, photos]) => ({ loc, photos }));
}
const photosOf = () => groupsOf(cur.tab).flatMap(g => g.photos);
const ptitle = p => p.loc ? p.loc + (p.layer ? " · " + p.layer : "") : p.name;
const annOf = id => S.anns.find(a => a.id === id);
const curPhoto = () => S.photos.find(x => x.id === cur.photo);
const STATUS = ["ativo", "pendente", "concluido"];
function fixAnn(a) { /* completa marcações de versões antigas ou backups incompletos (sem tags, histórico, status…) */
  const s = v => v == null ? "" : String(v), n = v => Number.isFinite(+v) ? +v : 0;
  a.name = s(a.name).trim() || "Marcação"; a.code = s(a.code); a.desc = s(a.desc); a.notes = s(a.notes);
  a.tags = Array.isArray(a.tags) ? a.tags.map(s).filter(Boolean) : s(a.tags).split(",").map(t => t.trim()).filter(Boolean);
  a.status = STATUS.includes(a.status) ? a.status : "ativo";
  a.hist = Array.isArray(a.hist) ? a.hist : []; a.hidden = !!a.hidden;
  for (const k of ["pa", "lote", "cliente", "codCliente", "barras", "fonte"]) a[k] = s(a[k]).trim(); /* v11: dados da etiqueta (opcionais) */
  a.qtd = +a.qtd > 0 ? Math.trunc(+a.qtd) : ""; a.dataEtiq = /^\d{4}-\d{2}-\d{2}$/.test(s(a.dataEtiq)) ? s(a.dataEtiq) : "";
  a.leitura = a.leitura && typeof a.leitura === "object" ? a.leitura : null;
  a.w = clamp(n(a.w), 0.01, 1); a.h = clamp(n(a.h), 0.01, 1); a.x = clamp(n(a.x), 0, 1 - a.w); a.y = clamp(n(a.y), 0, 1 - a.h);
  if (!a.created) a.created = now(); if (!a.updated) a.updated = a.created;
  return a;
}

/* ============================================================ 4. VALIDAÇÃO E BACKUP (ZIP) */
const MAX_BYTES = 25 * 1024 * 1024, TYPES = ["image/jpeg", "image/png", "image/webp"];
function loadDims(file) {
  return new Promise((ok, no) => {
    const u = URL.createObjectURL(file), i = new Image();
    i.onload = () => { ok({ w: i.naturalWidth, h: i.naturalHeight }); URL.revokeObjectURL(u); };
    i.onerror = () => { URL.revokeObjectURL(u); no(new Error("imagem corrompida ou ilegível")); };
    i.src = u;
  });
}
function validBackup(d) {
  const n = v => typeof v === "number" && v >= 0 && v <= 1;
  if (!d || d.format !== "fotolocalizador-backup") throw new Error("não é um backup do FotoLocalizador");
  if (d.version !== 1 && d.version !== 2) throw new Error("versão de backup não suportada: " + d.version);
  if (![d.tabs, d.photos, d.anns].every(Array.isArray)) throw new Error("estrutura inválida");
  const ids = new Set();
  for (const x of [...d.tabs, ...d.photos, ...d.anns]) {
    if (!x || typeof x.id !== "string" || ids.has(x.id)) throw new Error("identificador ausente ou duplicado");
    ids.add(x.id);
  }
  const tabs = new Set(d.tabs.map(t => t.id)), ph = new Set(d.photos.map(p => p.id));
  for (const p of d.photos) if (!tabs.has(p.tab) || (d.version === 2 ? typeof p.file !== "string" : typeof p.data !== "string") || !TYPES.includes(p.mime)) throw new Error("foto inválida: " + p.id);
  for (const a of d.anns) if (!ph.has(a.photo) || ![a.x, a.y, a.w, a.h].every(n) || a.x + a.w > 1.0001 || a.y + a.h > 1.0001) throw new Error("marcação inválida: " + a.id);
}

/* --- ZIP sem compressão (lê também o JSON antigo) --- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipBuild(entries) { /* entries: {name, blob, crc, size}; método 0 (store), UTF-8 */
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const e of entries) {
    const nm = enc.encode(e.name), lh = new DataView(new ArrayBuffer(30)), ch = new DataView(new ArrayBuffer(46));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, e.crc, true); lh.setUint32(18, e.size, true); lh.setUint32(22, e.size, true); lh.setUint16(26, nm.length, true);
    parts.push(lh.buffer, nm, e.blob);
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, e.crc, true); ch.setUint32(20, e.size, true); ch.setUint32(24, e.size, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    cen.push(ch.buffer, nm); off += 30 + nm.length + e.size;
  }
  if (off > 0xFFFFFFF0) throw new Error("backup maior que 4 GB: exporte por partes");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cen.reduce((a, b) => a + b.byteLength, 0), true); end.setUint32(16, off, true);
  return new Blob([...parts, ...cen, end.buffer], { type: "application/zip" });
}
async function zipRead(file) {
  const tail = new DataView(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
  let e = -1; for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("ZIP inválido");
  const n = tail.getUint16(e + 10, true), cs = tail.getUint32(e + 12, true), co = tail.getUint32(e + 16, true);
  const cd = new DataView(await file.slice(co, co + cs).arrayBuffer()), dec = new TextDecoder(), out = new Map(); let p = 0;
  for (let i = 0; i < n; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP corrompido");
    const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    if (cd.getUint16(p + 10, true) !== 0) throw new Error("ZIP comprimido não suportado: use um backup gerado pelo app");
    out.set(dec.decode(new Uint8Array(cd.buffer, p + 46, nl)), { lo: cd.getUint32(p + 42, true), sz: cd.getUint32(p + 24, true), crc: cd.getUint32(p + 16, true) });
    p += 46 + nl + xl + cl;
  }
  for (const v of out.values()) {
    const lh = new DataView(await file.slice(v.lo, v.lo + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error("ZIP corrompido");
    v.start = v.lo + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  }
  return { has: k => out.has(k), crc: k => out.get(k).crc, blob: (k, type) => { const v = out.get(k); return file.slice(v.start, v.start + v.sz, type || ""); } };
}

/* --- exportar / importar --- */
const d2b = d => {
  const m = /^data:([^;]+);base64,(.*)$/.exec(d); if (!m) throw new Error("dados de imagem inválidos");
  const bin = atob(m[2]), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: m[1] });
};
const crcOf = async b => crc32(new Uint8Array(await b.arrayBuffer()));
async function exportBackup(auto) {
  const ent = [], meta = [];
  for (const p of S.photos) {
    await withBlob(p); const nm = "photos/" + p.id; ent.push({ name: nm, blob: p.blob, crc: await crcOf(p.blob), size: p.blob.size });
    const { blob, thumb, ...r } = p; meta.push({ ...r, file: nm });
  }
  const js = new Blob([JSON.stringify({ format: "fotolocalizador-backup", version: 2, exported: now(), tabs: S.tabs, photos: meta, anns: S.anns })]);
  ent.unshift({ name: "backup.json", blob: js, crc: await crcOf(js), size: js.size });
  const name = (auto ? "fotolocalizador-ANTES-de-importar-" : "fotolocalizador-backup-") + now().slice(0, 10) + ".zip";
  const a = h("a", { href: URL.createObjectURL(zipBuild(ent)), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}
async function importBackup(f) {
  let d, zip = null;
  if (/\.zip$/i.test(f.name) || f.type === "application/zip") {
    zip = await zipRead(f); if (!zip.has("backup.json")) throw new Error("ZIP sem backup.json");
    d = JSON.parse(await zip.blob("backup.json").text());
  } else d = JSON.parse(await f.text());
  validBackup(d);
  if (d.version === 2) { if (!zip) throw new Error("backup versão 2 precisa estar em ZIP"); for (const p of d.photos) if (!zip.has(p.file)) throw new Error("foto ausente no ZIP: " + p.id); }
  const had = S.photos.length || S.anns.length;
  const text = d.tabs.length + " aba(s), " + d.photos.length + " foto(s), " + d.anns.length + " marcação(ões). Isso SUBSTITUI todos os dados atuais" + (had ? "; antes, o app baixa um backup do que existe agora." : ".");
  if (!(await ask("Importar backup?", { msg: text, ok: "Substituir tudo", danger: true }))) return;
  const photos = [];
  for (const p of d.photos) {
    if (d.version === 2) { const { file, ...r } = p, b = zip.blob(file, p.mime); if ((await crcOf(b)) !== zip.crc(file)) throw new Error("foto corrompida no ZIP: " + p.id); photos.push({ ...r, blob: b }); }
    else { const { data, ...r } = p; photos.push({ ...r, blob: d2b(data) }); }
  }
  const anns = d.anns.map(a => fixAnn({ ...a }));
  if (had) await exportBackup(true);
  const tx = dbTx(STORES, "readwrite");
  for (const s of STORES) tx.objectStore(s).clear();
  d.tabs.forEach(t => tx.objectStore("tabs").put(t));
  photos.forEach(p => { const { blob, ...m } = p; tx.objectStore("photos").put(m); tx.objectStore("blobs").put({ id: p.id, blob }); });
  anns.forEach(a => tx.objectStore("anns").put(a));
  await txDone(tx);
  for (const k of Object.keys(urls)) { URL.revokeObjectURL(urls[k]); delete urls[k]; }
  S.tabs = d.tabs; S.photos = photos; S.anns = anns; S.trash = [];
  cur.tab = (S.tabs.slice().sort(byDate)[0] || {}).id || null; cur.sel = null; cur.dirty = false;
  await migrateOrder();
  cur.photo = (photosOf()[0] || {}).id || null;
  $("#img").dataset.id = ""; renderAll(); toast("Backup importado"); ensureThumbs(); storageInfo();
}

/* ============================================================ 5. ABAS */
async function addTab(name) {
  const t = { id: uid(), name, created: now(), updated: now() };
  await put("tabs", t); S.tabs.push(t); return t;
}
function renderTabs() {
  $("#tabs").replaceChildren(...S.tabs.slice().sort(byDate).map(t => h("button", {
    type: "button", role: "tab", "aria-selected": String(t.id === cur.tab), onclick: () => switchTab(t.id)
  }, t.name + " ", h("span", { class: "cnt" }, String(S.photos.filter(p => p.tab === t.id).length)))));
  $("#tDel").disabled = S.tabs.length < 1;
}
async function switchTab(id) {
  if (!(await guard())) return;
  cur.tab = id; cur.photo = (photosOf()[0] || {}).id || null; cur.sel = null; cur.mode = null;
  renderAll();
}

/* ============================================================ 6. ENDEREÇO (andar › corredor › prateleira) */
const ADDR = /^A([A-Z0-9]{1,3}) › C([A-Z0-9]{1,3}) › P([A-Z0-9]{1,3})$/;
const addrParse = loc => { const m = ADDR.exec(String(loc || "").toUpperCase()); return m ? { a: m[1], c: m[2], p: m[3] } : null; };
function addrPart(v, pre, pad) { /* aceita "2" ou "A2"; corredor numérico vira 2 dígitos ("3" → "03") */
  let x = String(v || "").trim().toUpperCase().replace(/\s+/g, "");
  if (x.startsWith(pre) && /\d/.test(x[1] || "")) x = x.slice(1);
  if (!/^[A-Z0-9]{1,3}$/.test(x)) return null;
  return pad && /^\d+$/.test(x) ? x.padStart(2, "0") : x;
}
async function askAddr(title, text, loc0, ok, extra) { /* devolve {loc, rest} ou null; loc "" = sem endereço */
  let v = addrParse(loc0) || { a: "", c: "", p: "" };
  for (;;) {
    const r = await ask(title, { msg: text, ok: ok || "Salvar", fields: [{ label: "Andar", value: v.a, ph: "2" }, { label: "Corredor", value: v.c, ph: "03" }, { label: "Prateleira", value: v.p, ph: "4" }, ...(extra || [])] });
    if (!r) return null;
    v = { a: r[0], c: r[1], p: r[2] };
    if (!r[0] && !r[1] && !r[2]) return { loc: "", rest: r.slice(3) };
    const a = addrPart(r[0], "A"), c = addrPart(r[1], "C", true), p = addrPart(r[2], "P");
    if (!a || !c || !p) { toast("Preencha andar, corredor e prateleira (até 3 letras ou números cada) ou deixe os três em branco.", true); continue; }
    return { loc: "A" + a + " › C" + c + " › P" + p, rest: r.slice(3) };
  }
}

/* ============================================================ 7. FOTOS */
async function makeThumb(file) {
  try {
    const bmp = await createImageBitmap(file), k = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); if (bmp.close) bmp.close();
    return await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.8));
  } catch (e) { return null; /* sem miniatura: a interface usa a foto original */ }
}
async function ensureThumbs() {
  const todo = S.photos.filter(p => !p.thumb);
  if (!todo.length) return;
  let n = 0;
  for (const p of todo) {
    let t; try { await withBlob(p); t = await makeThumb(p.blob); } catch (e) { continue; } if (!t) continue;
    p.thumb = t; n++;
    try { await put("photos", p); } catch (e) { p.thumb = null; }
  }
  if (n) { renderThumbs(); if ($("#q").value.trim()) renderResults($("#q").value); }
}
async function migrateOrder() {
  const miss = S.photos.filter(p => typeof p.order !== "number");
  if (!miss.length) return;
  let m = S.photos.reduce((a, p) => Math.max(a, typeof p.order === "number" ? p.order : 0), 0);
  for (const p of miss.sort(byDate)) p.order = ++m;
  try { await putMany("photos", miss); } catch (e) { /* ordem fica só em memória; aviso já exibido */ }
}
const MAXSIDE = 2560;
async function shrink(file) { /* lado maior > 2560 px vira JPEG 88%: guarda bem menos espaço e continua legível */
  try {
    const bmp = await createImageBitmap(file), k = MAXSIDE / Math.max(bmp.width, bmp.height);
    const w = Math.round(bmp.width * k), hh = Math.round(bmp.height * k), c = document.createElement("canvas"); c.width = w; c.height = hh;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, hh); x.drawImage(bmp, 0, 0, w, hh); if (bmp.close) bmp.close();
    const blob = await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.88));
    return blob ? { blob, w, h: hh } : null;
  } catch (e) { return null; /* sem redução: guarda a original */ }
}
let shrinkOn = true;
try { shrinkOn = localStorage.getItem("fl-shrink") !== "0"; } catch (e) { /* preferência opcional */ }
async function addFiles(files) {
  const r = await askAddr("Local das fotos", "Informe o endereço em três campos: 2, 3 e 4 viram A2 › C03 › P4. As fotos viram fileiras em ordem: frente, trás, 3, final. Deixe os três em branco para não agrupar.", "", "Adicionar");
  if (r === null) return;
  const loc = r.loc;
  let ok = 0; const errs = [];
  for (const f of files) {
    try {
      if (!TYPES.includes(f.type)) throw new Error("formato não suportado (use JPEG, PNG ou WebP)");
      if (f.size > MAX_BYTES) throw new Error("arquivo acima de 25 MB");
      if (f.size === 0) throw new Error("arquivo vazio");
      const d = await loadDims(f);
      const n = S.photos.filter(x => x.tab === cur.tab && x.loc === loc).length;
      const order = S.photos.reduce((a, x) => Math.max(a, x.order || 0), 0) + 1;
      let blob = f, dim = d;
      if (shrinkOn && Math.max(d.w, d.h) > MAXSIDE) { const s = await shrink(f); if (s && s.blob.size < f.size) { blob = s.blob; dim = { w: s.w, h: s.h }; } }
      const p = { id: uid(), tab: cur.tab, name: f.name, mime: blob.type, size: blob.size, w: dim.w, h: dim.h, created: now(), order, loc, layer: loc ? (LAYERS[n] || "Fileira " + (n + 1)) : "", blob, thumb: await makeThumb(blob) };
      await putPhoto(p); S.photos.push(p); cur.photo = cur.photo || p.id; ok++;
    } catch (e) { errs.push(f.name + ": " + msg(e)); }
  }
  renderAll(); storageInfo();
  if (errs.length) toast(errs.length + " arquivo(s) recusado(s) — " + errs[0], true);
  else if (ok) toast(ok + " foto(s) adicionada(s)");
}
function renderThumbs() {
  const gs = groupsOf(cur.tab), list = gs.flatMap(g => g.photos), cnt = new Map();
  for (const a of S.anns) cnt.set(a.photo, (cnt.get(a.photo) || 0) + 1);
  $("#pInfo").textContent = list.length + " foto(s)";
  $("#locs").replaceChildren(...[...new Set(S.photos.map(p => p.loc).filter(Boolean))].map(v => h("option", { value: v })));
  const mk = p => h("button", {
    type: "button", class: "th", "aria-label": "Abrir " + p.name, "aria-current": String(p.id === cur.photo),
    onclick: async () => { if (await guard()) { cur.photo = p.id; cur.sel = null; cur.mode = null; renderAll(); } }
  }, h("img", { src: turl(p), alt: "", loading: "lazy" }), h("span", { class: "tc" }, p.layer || p.name));
  $("#thumbs").replaceChildren(...gs.map(g => h("div", { class: "grp" },
    h("div", { class: "gt" }, (g.loc || "Sem local") + " ",
      h("span", { class: "cnt" }, g.photos.length + " foto(s) · " + g.photos.reduce((n, p) => n + (cnt.get(p.id) || 0), 0) + " marcação(ões)"),
      g.loc ? h("button", { type: "button", class: "mini ghost", "aria-label": "Renomear local " + g.loc, onclick: () => renameLoc(cur.tab, g.loc) }, "Renomear local") : null),
    h("div", { class: "strip" }, g.photos.map(mk)))));
}
async function stepPhoto(d) {
  const l = photosOf(), i = l.findIndex(p => p.id === cur.photo);
  if (l.length < 2 || !(await guard())) return;
  cur.photo = l[(i + d + l.length) % l.length].id; cur.sel = null; cur.mode = null; renderAll();
}
async function movePhoto(d) {
  const p = curPhoto(); if (!p) return;
  const g = groupsOf(cur.tab).find(x => x.photos.includes(p)); if (!g) return;
  const q = g.photos[g.photos.indexOf(p) + d];
  if (!q) { toast("A foto já está " + (d < 0 ? "no início" : "no fim") + " deste local."); return; }
  const o = { po: p.order, pl: p.layer, qo: q.order, ql: q.layer };
  p.order = o.qo; q.order = o.po;
  if (p.loc) { p.layer = o.ql; q.layer = o.pl; }
  try { await putMany("photos", [p, q]); }
  catch (e) { p.order = o.po; p.layer = o.pl; q.order = o.qo; q.layer = o.ql; }
  renderAll();
}
async function renameLoc(tabId, oldLoc) {
  const rr = await askAddr("Renomear local", "Vale para todas as fotos deste local nesta aba." + (addrParse(oldLoc) ? "" : " Local atual (formato antigo): " + oldLoc), oldLoc, "Salvar");
  const nn = rr && rr.loc; if (!nn || nn === oldLoc) return;
  const ps = S.photos.filter(p => p.tab === tabId && p.loc === oldLoc);
  const merge = S.photos.some(p => p.tab === tabId && p.loc === nn);
  if (merge && !(await ask("Juntar locais?", { msg: "Já existe o local “" + nn + "”. As " + ps.length + " foto(s) serão juntadas a ele, no fim da lista.", ok: "Juntar" }))) return;
  const old = ps.map(p => ({ p, loc: p.loc, order: p.order }));
  let m = S.photos.reduce((a, x) => Math.max(a, x.order || 0), 0);
  for (const p of ps.slice().sort(byOrder)) { p.loc = nn; if (merge) p.order = ++m; }
  try { await putMany("photos", ps); toast("Local renomeado em " + ps.length + " foto(s)"); }
  catch (e) { old.forEach(o => { o.p.loc = o.loc; o.p.order = o.order; }); }
  renderAll();
}

/* ============================================================ 8. VISUALIZADOR E TELA CHEIA */
const ZMIN = 0.25, ZMAX = 8;

function fitZoom() { /* "Ajustar": a foto inteira cabe na área visível */
  const p = curPhoto(), st = $("#stage");
  if (!p || !p.w || !p.h || !st.clientWidth) return 1;
  const H = cur.fs ? st.clientHeight : window.innerHeight * 0.62;
  return clamp(Math.min(1, (H * p.w) / (st.clientWidth * p.h)), ZMIN, 1);
}
function applyZoom() { $("#wrap").style.width = cur.zoom * 100 + "%"; $("#zl").textContent = Math.round(cur.zoom * 100) + "%"; }
function setZoom(z, ax = 0.5, ay = 0.5) { /* zoom mantendo o ponto (ax, ay) da área visível parado na tela */
  z = clamp(z, ZMIN, ZMAX); if (Math.abs(z - cur.zoom) < 1e-4) return;
  const st = $("#stage"), w = $("#wrap"), sr = st.getBoundingClientRect(), wr = w.getBoundingClientRect();
  const px = sr.left + st.clientLeft + ax * st.clientWidth, py = sr.top + st.clientTop + ay * st.clientHeight;
  const fx = clamp((px - wr.left) / (wr.width || 1), 0, 1), fy = clamp((py - wr.top) / (wr.height || 1), 0, 1);
  cur.zoom = z; applyZoom();
  const w2 = w.getBoundingClientRect();
  st.scrollLeft += w2.left + fx * w2.width - px; st.scrollTop += w2.top + fy * w2.height - py;
}
function centerOn(a) {
  if (!a) return;
  requestAnimationFrame(() => { const w = $("#wrap"), st = $("#stage"); st.scrollLeft = (a.x + a.w / 2) * w.clientWidth - st.clientWidth / 2; st.scrollTop = (a.y + a.h / 2) * w.clientHeight - st.clientHeight / 2; });
}
function revealSel() { /* garante que a marcação selecionada fique visível (o painel de edição ocupa parte da tela) */
  setTimeout(() => { const el = $(".ann.sel"); if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" }); }, 160);
}

function renderViewer() {
  const p = curPhoto();
  $("#empty").hidden = !!p; $("#viewer").hidden = !p;
  if (!p) { if (cur.fs) exitFs(); return; }
  const img = $("#img");
  if (img.dataset.id !== p.id) { /* trocou de foto */
    img.dataset.id = p.id; img.alt = p.name;
    img.style.aspectRatio = p.w && p.h ? p.w + " / " + p.h : "";
    if (cur.keepZoom) cur.keepZoom = false; else cur.zoom = fitZoom();
    if (p.blob) img.src = url(p);
    else withBlob(p).then(() => { if (img.dataset.id === p.id) img.src = url(p); }).catch(e => toast("Foto indisponível: " + msg(e), true));
  }
  applyZoom();
  const all = S.anns.filter(a => a.photo === p.id).sort(byDate);
  $("#pname").textContent = ptitle(p);
  $("#pfile").textContent = p.name + " · " + all.length + " marcação(ões)";
  $("#aNew").setAttribute("aria-pressed", String(cur.mode === "draw"));
  $("#hint").textContent = cur.mode === "draw" ? "Arraste sobre a foto para desenhar a região da marcação." : "Toque numa marcação para editar; arraste para mover e use o círculo para redimensionar.";
  const L = $("#layer"); L.classList.toggle("draw", cur.mode === "draw");
  renderChips(all);
  L.replaceChildren(...all.filter(a => !a.hidden || a.id === cur.sel).map((a, _, vis) =>
    h("div", {
      class: "ann" + (a.id === cur.sel ? " sel" : "") + (a.hidden ? " hid" : "") + (a.y < 0.05 ? " top" : ""),
      "data-id": a.id, "data-st": a.status, tabindex: "0", role: "button", "aria-label": "Marcação " + a.name,
      style: `left:${a.x * 100}%;top:${a.y * 100}%;width:${a.w * 100}%;height:${a.h * 100}%`
    }, h("span", { class: "b3", "aria-hidden": "true" }, h("i", { class: "f" }), h("i", { class: "t" }), h("i", { class: "s" })),
      h("span", { class: "lbl" }, (all.indexOf(a) + 1) + ". " + a.name), h("i", { class: "hdl" }))));
}
function renderChips(all) {
  $("#alist").replaceChildren(...all.map((a, i) => h("button", {
    type: "button", "data-st": a.status, class: "chip" + (a.id === cur.sel ? " on" : "") + (a.hidden ? " off" : ""),
    onclick: async () => { if (await select(a.id)) { centerOn(annOf(a.id)); revealSel(); } }
  }, (i + 1) + ". " + a.name)));
}

/* --- tela cheia: a foto, as ferramentas de marcação e o editor ficam todos disponíveis --- */
let nativeFs = false;
async function enterFs() {
  if (cur.fs || !curPhoto()) return;
  cur.fs = true; document.body.classList.add("fs");
  $("#fs").textContent = "Sair da tela cheia"; $("#fs").setAttribute("aria-pressed", "true");
  try { history.pushState({ fs: 1 }, ""); } catch (e) { /* o botão "Sair" continua funcionando */ }
  syncSheet();
  requestAnimationFrame(() => { cur.zoom = fitZoom(); applyZoom(); });
  const el = document.documentElement;
  if (el.requestFullscreen) { try { await el.requestFullscreen({ navigationUI: "hide" }); nativeFs = true; } catch (e) { nativeFs = false; /* sem tela cheia nativa: usa o modo que cobre a página */ } }
  else if (el.webkitRequestFullscreen) { try { el.webkitRequestFullscreen(); nativeFs = true; } catch (e) { nativeFs = false; } }
}
function leaveFs() { /* só desfaz o modo (não mexe no histórico) */
  if (!cur.fs) return;
  cur.fs = false; document.body.classList.remove("fs", "sheet"); document.body.style.removeProperty("--sh");
  $("#fs").textContent = "Tela cheia"; $("#fs").setAttribute("aria-pressed", "false");
  if (nativeFs && (document.fullscreenElement || document.webkitFullscreenElement)) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) { /* já saiu */ } }
  nativeFs = false;
  requestAnimationFrame(() => { cur.zoom = fitZoom(); applyZoom(); revealSel(); });
}
function exitFs() {
  if (!cur.fs) return;
  if (history.state && history.state.fs) history.back(); /* o popstate chama leaveFs() */
  else leaveFs();
}
function syncSheet() { /* reserva espaço para o painel de edição (folha inferior) */
  const ed = $("#editor"), open = cur.fs && !ed.hidden;
  document.body.classList.toggle("sheet", open);
  const side = matchMedia("(orientation: landscape) and (min-width: 700px)").matches;
  document.body.style.setProperty("--sh", open && !side ? ed.offsetHeight + "px" : "0px");
}
window.addEventListener("popstate", () => leaveFs());
document.addEventListener("fullscreenchange", () => { if (cur.fs && nativeFs && !document.fullscreenElement) { nativeFs = false; exitFs(); } });
document.addEventListener("webkitfullscreenchange", () => { if (cur.fs && nativeFs && !document.webkitFullscreenElement) { nativeFs = false; exitFs(); } });
if ("ResizeObserver" in window) new ResizeObserver(syncSheet).observe($("#editor"));
window.addEventListener("resize", syncSheet);

/* ============================================================ 9. MARCAÇÕES (desenhar, mover, redimensionar) */
let dragEndAt = 0;
function drag(ev, onMove, onEnd) {
  ev.preventDefault();
  const L = $("#layer"), r = L.getBoundingClientRect();
  L.setPointerCapture(ev.pointerId);
  const pt = e => ({ x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) });
  const p0 = pt(ev);
  const mv = e => onMove(pt(e), p0);
  const up = () => { dragEndAt = performance.now(); L.removeEventListener("pointermove", mv); L.removeEventListener("pointerup", up); L.removeEventListener("pointercancel", up); onEnd(); };
  L.addEventListener("pointermove", mv); L.addEventListener("pointerup", up); L.addEventListener("pointercancel", up);
}
function setBox(el, a) { el.style.left = a.x * 100 + "%"; el.style.top = a.y * 100 + "%"; el.style.width = a.w * 100 + "%"; el.style.height = a.h * 100 + "%"; }
async function select(id) {
  if (cur.sel === id) return true;
  if (!(await guard())) return false;
  cur.sel = id; renderViewer(); renderEditor(); revealSel(); return true;
}
async function deselect() {
  if (!cur.sel || !(await guard())) return;
  cur.sel = null; renderViewer(); renderEditor();
}
$("#layer").addEventListener("pointerdown", async ev => {
  const p = curPhoto(); if (!p) return;
  if (cur.mode === "draw") {
    const tmp = h("div", { class: "ann sel" }); $("#layer").append(tmp);
    const b = { x: 0, y: 0, w: 0, h: 0 };
    drag(ev, (q, p0) => { b.x = Math.min(q.x, p0.x); b.y = Math.min(q.y, p0.y); b.w = Math.abs(q.x - p0.x); b.h = Math.abs(q.y - p0.y); setBox(tmp, b); },
      async () => {
        tmp.remove(); cur.mode = null;
        if (b.w > 0.01 && b.h > 0.01 && await guard()) {
          const n = S.anns.filter(a => a.photo === p.id).length + 1;
          const a = { id: uid(), photo: p.id, tab: p.tab, name: "Marcação " + n, code: "", desc: "", notes: "", tags: [], status: "ativo", ...b, hidden: false, created: now(), updated: now(), hist: [] };
          try { await put("anns", a); } catch (e) { renderViewer(); return; }
          S.anns.push(a); cur.sel = a.id; renderAll(); revealSel();
          if (!cur.fs) { $("#editor").scrollIntoView({ block: "nearest", behavior: "smooth" }); $("#eName").focus({ preventScroll: true }); $("#eName").select(); } /* em tela cheia o teclado cobriria a foto: o usuário toca no campo quando quiser */
          toast("Marcação criada — preencha os dados e toque em Salvar");
        } else renderViewer();
      });
    return;
  }
  const el = ev.target.closest(".ann"); if (!el) return;
  const a = annOf(el.dataset.id); if (!a) return;
  if (cur.sel !== a.id) { ev.preventDefault(); await select(a.id); return; }
  const resize = ev.target.classList.contains("hdl"), o = { x: a.x, y: a.y, w: a.w, h: a.h };
  drag(ev, (q, p0) => {
    if (resize) { a.w = clamp(q.x - a.x, 0.01, 1 - a.x); a.h = clamp(q.y - a.y, 0.01, 1 - a.y); }
    else { a.x = clamp(o.x + q.x - p0.x, 0, 1 - a.w); a.y = clamp(o.y + q.y - p0.y, 0, 1 - a.h); }
    setBox(el, a);
  }, async () => {
    if (a.x === o.x && a.y === o.y && a.w === o.w && a.h === o.h) return; /* só tocou: nada a gravar */
    a.updated = now(); try { await put("anns", a); } catch (e) { Object.assign(a, o); } renderViewer(); refreshMeta(a);
  });
});
$("#stage").addEventListener("click", ev => { /* toque num espaço vazio (foto ou fundo) fecha a seleção */
  if (!["stage", "wrap", "layer"].includes(ev.target.id) || cur.mode === "draw" || performance.now() - dragEndAt < 400) return;
  deselect();
});
let nudgeT;
$("#layer").addEventListener("keydown", e => { /* teclado: Enter seleciona; setas movem a marcação selecionada (Shift = passo maior) */
  const id = e.target.dataset && e.target.dataset.id; if (!id) return;
  if (e.key === "Enter") { select(id); return; }
  const a = annOf(id), k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!a || id !== cur.sel || !k) return;
  e.preventDefault(); const step = e.shiftKey ? 0.02 : 0.004;
  a.x = clamp(a.x + k[0] * step, 0, 1 - a.w); a.y = clamp(a.y + k[1] * step, 0, 1 - a.h); setBox(e.target, a);
  clearTimeout(nudgeT); nudgeT = setTimeout(async () => { a.updated = now(); try { await put("anns", a); refreshMeta(a); } catch (err) { /* aviso já exibido */ } }, 500);
});

/* ============================================================ 10. EDITOR E SALVAMENTO */
let edId = null, edSession = null, edTimer = null;
const FIELDS = ["#eName", "#eCode", "#eDesc", "#eNotes", "#eTags", "#eStat", "#ePa", "#eLote", "#eQtd", "#eDataE", "#eCli", "#eCodCli"];
const readForm = () => ({
  name: $("#eName").value.trim(), code: $("#eCode").value.trim(), desc: $("#eDesc").value.trim(), notes: $("#eNotes").value.trim(),
  tags: [...new Set($("#eTags").value.split(",").map(t => t.trim()).filter(Boolean))], status: $("#eStat").value,
  pa: $("#ePa").value.trim().toUpperCase(), lote: $("#eLote").value.trim().toUpperCase(), qtd: +$("#eQtd").value > 0 ? Math.trunc(+$("#eQtd").value) : "",
  dataEtiq: $("#eDataE").value, cliente: $("#eCli").value.trim(), codCliente: $("#eCodCli").value.trim()
});
function edState(text, cls) { const s = $("#eState"); s.textContent = text; s.className = "mut " + (cls || ""); }
function refreshMeta(a) {
  if (!a || edId !== a.id) return;
  $("#eMeta").textContent = "Criada: " + fmt(a.created) + " · Atualizada: " + fmt(a.updated);
  $("#eHide").textContent = a.hidden ? "Mostrar" : "Ocultar";
  const hl = $("#eHist"); hl.replaceChildren(...(a.hist || []).slice().reverse().map(x => h("li", {}, fmt(x.at) + " — " + x.name + (x.code ? " [" + x.code + "]" : "") + (x.desc ? ": " + x.desc : ""))));
  if (!hl.children.length) hl.append(h("li", {}, "Sem alterações anteriores."));
}
function renderEditor() {
  const a = annOf(cur.sel);
  if (a) fixAnn(a);
  $("#editor").hidden = !a && (cur.fs || !curPhoto()); /* sem marcação selecionada, fora da tela cheia, o painel explica o que fazer */
  $("#editor").classList.toggle("empty", !a); $("#eEmpty").hidden = !!a;
  if (!a) { edId = null; cur.dirty = false; clearTimeout(edTimer); syncSheet(); return; }
  if (cur.dirty && edId === a.id) { syncSheet(); return; } /* não sobrescreve o que o usuário está digitando */
  if (edId !== a.id) edSession = uid();
  cur.dirty = false; edId = a.id;
  $("#eName").value = a.name; $("#eCode").value = a.code; $("#eDesc").value = a.desc; $("#eNotes").value = a.notes;
  $("#eTags").value = a.tags.join(", "); $("#eStat").value = a.status;
  $("#ePa").value = a.pa; $("#eLote").value = a.lote; $("#eQtd").value = a.qtd; $("#eDataE").value = a.dataEtiq; $("#eCli").value = a.cliente; $("#eCodCli").value = a.codCliente;
  edState("");
  refreshMeta(a); syncSheet();
}
async function saveEditor({ silent = false } = {}) {
  clearTimeout(edTimer);
  const a = annOf(edId || cur.sel);
  if (!a) { if (!silent) toast("Nenhuma marcação selecionada. Toque numa marcação da foto (ou use “+ Marcação”) para editar.", true); return false; }
  const nu = readForm();
  if (!nu.name) { edState("Informe o nome para salvar", "err"); if (!silent) { toast("Informe o nome da marcação.", true); $("#eName").focus(); } return false; }
  const changed = ["name", "code", "desc", "notes", "pa", "lote", "qtd", "dataEtiq", "cliente", "codCliente"].some(k => a[k] !== nu[k]) || a.status !== nu.status || a.tags.join("\u0001") !== nu.tags.join("\u0001");
  if (!changed) { cur.dirty = false; edState("Salvo às " + hhmm(), "ok"); if (!silent) toast("Marcação salva"); return true; }
  const hist = a.hist || [], textChanged = ["name", "code", "desc", "notes"].some(k => a[k] !== nu[k]);
  const snap = { at: now(), sid: edSession, name: a.name, code: a.code, desc: a.desc, notes: a.notes }; /* 1 entrada de histórico por sessão de edição */
  const old = { ...a };
  Object.assign(a, nu, { updated: now(), hist: textChanged && !hist.some(x => x.sid === edSession) ? [...hist, snap].slice(-20) : hist });
  edState("Salvando…");
  try { await put("anns", a); }
  catch (e) { Object.assign(a, old); edState("Erro ao salvar — tente de novo", "err"); return false; }
  cur.dirty = JSON.stringify(readForm()) !== JSON.stringify(nu); /* se digitou durante a gravação, continua "não salvo" */
  if (cur.dirty) scheduleAutosave(); else edState("Salvo às " + hhmm(), "ok");
  if (!silent) toast("Marcação salva");
  renderViewer(); refreshMeta(a);
  if ($("#q").value.trim()) renderResults($("#q").value);
  return true;
}
function scheduleAutosave() { clearTimeout(edTimer); edTimer = setTimeout(() => saveEditor({ silent: true }), 900); }
for (const s of FIELDS) $(s).addEventListener("input", () => { cur.dirty = true; edState("Alterações não salvas…"); scheduleAutosave(); });
$("#eStat").addEventListener("change", () => saveEditor({ silent: true }));
async function guard() { /* chamado antes de trocar de marcação/foto/aba: salva sozinho; só pergunta se não der para salvar */
  if (!cur.dirty) return true;
  if (await saveEditor({ silent: true })) return true;
  const r = await ask("Descartar alterações?", { msg: "Não foi possível salvar a marcação (nome em branco ou erro de gravação). Descartar as alterações?", ok: "Descartar", danger: true });
  if (r) { cur.dirty = false; clearTimeout(edTimer); return true; }
  return false;
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && cur.dirty) saveEditor({ silent: true }); });
window.addEventListener("pagehide", () => { if (cur.dirty) saveEditor({ silent: true }); });
window.addEventListener("beforeunload", e => { if (cur.dirty) { e.preventDefault(); e.returnValue = ""; } });

$("#eSave").onclick = () => saveEditor();
$("#eCancel").onclick = () => deselect();
$("#eFold").onclick = () => {
  const ed = $("#editor"), f = ed.classList.toggle("folded");
  $("#eFold").textContent = f ? "▴ Expandir" : "▾ Recolher"; $("#eFold").setAttribute("aria-expanded", String(!f));
  syncSheet();
};
$("#eHide").onclick = async () => {
  const a = annOf(cur.sel); if (!a) return; a.hidden = !a.hidden;
  try { await put("anns", a); } catch (e) { a.hidden = !a.hidden; }
  renderViewer(); refreshMeta(a);
};
$("#eDup").onclick = async () => {
  const a = annOf(cur.sel); if (!a || !(await guard())) return;
  const c = { ...a, id: uid(), name: a.name + " (cópia)", x: clamp(a.x + 0.03, 0, 1 - a.w), y: clamp(a.y + 0.03, 0, 1 - a.h), hist: [], created: now(), updated: now(), tags: [...a.tags] };
  try { await put("anns", c); } catch (e) { return; }
  S.anns.push(c); cur.sel = c.id; renderAll(); toast("Marcação duplicada");
};
$("#eDel").onclick = async () => {
  const a = annOf(cur.sel); if (!a) return;
  if (!(await ask("Excluir marcação?", { msg: "“" + a.name + "” irá para a lixeira (fica 30 dias).", ok: "Excluir", danger: true }))) return;
  const rec = { id: uid(), kind: "ann", at: now(), name: a.name, data: a };
  try { await delMany([["anns", a.id]], [["trash", rec]]); } catch (e) { return; }
  S.trash.push(rec); S.anns = S.anns.filter(x => x.id !== a.id); cur.sel = null; cur.dirty = false; clearTimeout(edTimer); renderAll();
};

/* ============================================================ 11. PESQUISA */
const hayC = new WeakMap();
function hayOf(a, p) {
  const k = a.updated + "|" + (p.loc || "") + "|" + (p.layer || "") + "|" + (p.name || "");
  let c = hayC.get(a);
  if (!c || c.k !== k) { c = { k, h: norm([a.name, a.code, a.desc, a.notes, a.pa, a.lote, a.cliente, a.codCliente, a.qtd, ...(a.tags || []), p.loc, p.layer, p.name].join(" ")), n: norm(a.name), c: norm(a.code) }; hayC.set(a, c); }
  return c;
}
function search(q) {
  const t = norm(q); if (!t) return [];
  const words = t.split(/\s+/), pm = new Map(S.photos.map(p => [p.id, p])), out = [];
  for (const a of S.anns) {
    const c = hayOf(a, pm.get(a.photo) || {});
    if (!words.every(w => c.h.includes(w))) continue;
    out.push({ a, s: c.c && c.c === t ? 0 : c.n === t ? 1 : c.n.startsWith(t) ? 2 : c.n.includes(t) ? 3 : 4 });
  }
  return out.sort((x, y) => x.s - y.s).map(x => x.a); /* código exato, nome exato, começa com, contém, resto */
}
function searchLocs(q) {
  const words = norm(q).split(/\s+/).filter(Boolean), out = [];
  for (const t of S.tabs) for (const g of groupsOf(t.id)) {
    if (!words.length || !g.loc) continue;
    if (words.every(w => norm(g.loc).includes(w))) { out.push({ t, g }); continue; }
    for (const p of g.photos) if (words.every(w => norm(g.loc + " " + (p.layer || "")).includes(w))) out.push({ t, g, p });
  }
  return out;
}
async function openPhoto(p) {
  if (!p || !(await guard())) return;
  cur.tab = p.tab; cur.photo = p.id; cur.sel = null; cur.mode = null;
  renderAll(); $("#vcard").scrollIntoView({ block: "start", behavior: "smooth" });
}
const PAGE = 20; let resLimit = PAGE, resQ = "";
function renderResults(q) {
  if (q !== resQ) { resQ = q; resLimit = PAGE; }
  const box = $("#res"), hits = search(q), locs = searchLocs(q);
  if (!q.trim()) { box.replaceChildren(); return; }
  if (!hits.length && !locs.length) { box.replaceChildren(h("p", { class: "mut" }, "Nenhum resultado para “" + q.trim() + "”.")); return; }
  box.replaceChildren(h("p", { class: "mut", style: "margin:0" }, (hits.length + locs.length) + " resultado(s)"),
    ...locs.map(({ t, g, p }) => h("button", { type: "button", class: "hit loc", onclick: () => openPhoto(p || g.photos[0]) },
      h("img", { src: turl(p || g.photos[0]), alt: "" }),
      h("span", {}, h("strong", {}, "📦 " + g.loc + (p && p.layer ? " · " + p.layer : "")), h("small", {}, "Aba: " + t.name + " · " + (p ? "abrir esta fileira" : g.photos.length + " fileira(s) · abrir local"))))),
    ...hits.slice(0, resLimit).map(a => {
      const p = S.photos.find(x => x.id === a.photo), t = S.tabs.find(x => x.id === a.tab);
      return h("button", { type: "button", class: "hit", onclick: () => goTo(a.id) },
        p ? h("img", { src: turl(p), alt: "" }) : null,
        h("span", {}, h("strong", {}, a.name + (a.code ? " · " + a.code : "")),
          h("small", {}, [t && t.name, p && p.loc, p && p.layer].filter(Boolean).join(" › ") + " · " + (p ? p.name : "?")),
          a.desc ? h("small", {}, a.desc.slice(0, 90)) : null));
    }),
    hits.length > resLimit ? h("button", { type: "button", class: "pri", onclick: () => { resLimit += PAGE; renderResults(q); } }, "Mostrar mais (" + (hits.length - resLimit) + " restantes)") : null);
}
async function goTo(id) {
  const a = annOf(id); if (!a || !(await guard())) return;
  const ph0 = S.photos.find(x => x.id === a.photo); if (ph0) { try { await withBlob(ph0); } catch (e) { toast("Foto indisponível: " + msg(e), true); return; } }
  cur.tab = a.tab; cur.photo = a.photo; cur.sel = id; cur.mode = null;
  cur.zoom = clamp(0.5 / Math.max(a.w, a.h), 1, 4); cur.keepZoom = true;
  renderAll();
  const img = $("#img"); try { await img.decode(); } catch (e) { /* imagem ainda carregando */ }
  requestAnimationFrame(() => {
    const w = $("#wrap"), st = $("#stage");
    st.scrollLeft = (a.x + a.w / 2) * w.clientWidth - st.clientWidth / 2;
    st.scrollTop = (a.y + a.h / 2) * w.clientHeight - st.clientHeight / 2;
    const el = $(`.ann[data-id="${CSS.escape(id)}"]`); if (el) { el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 2300); }
    $("#vcard").scrollIntoView({ block: "start", behavior: "smooth" });
  });
}
$("#sf").addEventListener("submit", e => { e.preventDefault(); const hits = search($("#q").value); renderResults($("#q").value); if (hits.length === 1) goTo(hits[0].id); });
let qt; $("#q").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(() => renderResults($("#q").value), 150); });

/* ============================================================ 12. LIXEIRA (30 dias) */
async function restoreTrash(t) {
  try {
    if (t.kind === "ann") {
      if (!S.photos.some(p => p.id === t.data.photo)) { toast("A foto desta marcação não existe mais.", true); return false; }
      fixAnn(t.data); await delMany([["trash", t.id]], [["anns", t.data]]); S.anns.push(t.data);
    } else {
      const m = { ...t.data.meta }; if (!S.tabs.some(x => x.id === m.tab)) m.tab = cur.tab;
      const anns = t.data.anns.map(a => fixAnn({ ...a, tab: m.tab }));
      await delMany([["trash", t.id]], [["photos", m], ["blobs", { id: m.id, blob: t.data.blob }], ...anns.map(a => ["anns", a])]);
      m.blob = t.data.blob; S.photos.push(m); S.anns.push(...anns);
    }
    S.trash = S.trash.filter(x => x.id !== t.id); renderAll(); toast("Restaurado"); return true;
  } catch (e) { return false; /* aviso já exibido */ }
}
function openTrash() {
  const d = $("#dlg"), f = $("#dlgbody");
  const gone = async list => { try { await delMany(list.map(t => ["trash", t.id])); S.trash = S.trash.filter(x => !list.includes(x)); } catch (e) { /* aviso já exibido */ } draw(); };
  const draw = () => {
    renderAll();
    f.replaceChildren(h("h3", {}, "Lixeira"), h("p", {}, "Os itens ficam aqui por 30 dias. A exclusão de aba inteira não passa pela lixeira."),
      ...(S.trash.length ? S.trash.slice().sort((a, b) => a.at < b.at ? 1 : -1).map(t => h("div", { class: "row mini-row" },
        h("span", {}, (t.kind === "photo" ? "📷 " : "▭ ") + t.name + " · " + fmt(t.at) + (t.kind === "photo" ? " · " + t.data.anns.length + " marcação(ões)" : "")),
        h("span", { class: "row" },
          h("button", { type: "button", class: "pri mini", onclick: async () => { await restoreTrash(t); draw(); } }, "Restaurar"),
          h("button", { type: "button", class: "danger mini", onclick: () => gone([t]) }, "Apagar")))) : [h("p", { class: "mut" }, "Lixeira vazia.")]),
      h("div", { class: "row", style: "margin-top:10px;justify-content:flex-end" },
        S.trash.length ? h("button", { type: "button", class: "danger", onclick: async () => { if (await ask("Esvaziar lixeira?", { msg: "Apaga " + S.trash.length + " item(ns) de vez.", ok: "Esvaziar", danger: true })) { await gone(S.trash.slice()); } openTrash(); } }, "Esvaziar") : null,
        h("button", { type: "button", class: "ghost", onclick: () => d.close() }, "Fechar")));
  };
  f.onkeydown = null; d.oncancel = null; draw(); d.showModal();
}

/* ============================================================ 13. SISTEMA (espaço, outras abas, offline) */
async function storageInfo() {
  try {
    const st = navigator.storage; if (!st || !st.estimate) return;
    if (S.photos.length && st.persist && st.persisted && !(await st.persisted())) await st.persist();
    const { usage = 0, quota = 0 } = await st.estimate(), pers = st.persisted ? await st.persisted() : false;
    const mb = v => v >= 1e9 ? (v / 1e9).toFixed(1) + " GB" : Math.round(v / 1e6) + " MB";
    $("#stor").textContent = "Espaço: " + mb(usage) + " de " + mb(quota) + (pers ? " · protegido" : " · o navegador pode apagar");
    if (quota && usage / quota > 0.8) toast("Armazenamento acima de 80%. Exporte um backup e apague fotos antigas.", true);
  } catch (e) { /* medidor é opcional */ }
}
const showShrink = () => { $("#bRes").textContent = "Reduzir fotos grandes: " + (shrinkOn ? "ligado" : "desligado"); $("#bRes").setAttribute("aria-pressed", String(shrinkOn)); };
if (bc) bc.onmessage = () => { $("#bSync").hidden = false; };
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  const had = !!navigator.serviceWorker.controller; /* se já havia versão instalada, a troca vira aviso "recarregar" */
  navigator.serviceWorker.register("sw.js").then(r => r.update && r.update()).catch(() => { /* offline é opcional */ });
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (had) $("#bUpd").hidden = false; });
}

/* ============================================================ 14. LIGAÇÕES DA INTERFACE */
/* cabeçalho */
$("#bTrash").onclick = openTrash;
$("#bExp").onclick = async () => { $("#menu").open = false; try { await exportBackup(false); toast("Backup gerado (ZIP)"); } catch (e) { toast("Falha no backup: " + msg(e), true); } };
$("#bImp").onclick = () => { $("#menu").open = false; $("#fImp").click(); };
$("#fImp").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try { await importBackup(f); } catch (err) { toast("Importação recusada (dados atuais preservados): " + msg(err), true); }
};
$("#bRes").onclick = () => { shrinkOn = !shrinkOn; try { localStorage.setItem("fl-shrink", shrinkOn ? "1" : "0"); } catch (e) { /* preferência opcional */ } showShrink(); };
$("#bSync").onclick = async () => { if (await guard()) location.reload(); };
$("#bUpd").onclick = async () => { if (await guard()) location.reload(); };
document.addEventListener("click", e => { const m = $("#menu"); if (m.open && !m.contains(e.target)) m.open = false; });
showShrink();

/* abas */
$("#tNew").onclick = async () => { const n = await ask("Nova aba", { label: "Nome da aba", ok: "Criar" }); if (n) { try { const t = await addTab(n); await switchTab(t.id); } catch (e) { /* aviso já exibido por put() */ } } };
$("#tRen").onclick = async () => {
  const t = S.tabs.find(x => x.id === cur.tab); if (!t) return;
  const n = await ask("Renomear aba", { label: "Nome da aba", value: t.name, ok: "Salvar" });
  if (n) { const o = t.name; t.name = n; t.updated = now(); try { await put("tabs", t); } catch (e) { t.name = o; } renderAll(); }
};
$("#tDel").onclick = async () => {
  const t = S.tabs.find(x => x.id === cur.tab); if (!t) return;
  const np = S.photos.filter(p => p.tab === t.id).length;
  if (!(await ask("Excluir aba?", { msg: "“" + t.name + "” e suas " + np + " foto(s) e marcações serão apagadas permanentemente.", ok: "Excluir", danger: true }))) return;
  const ph = S.photos.filter(p => p.tab === t.id), pid = new Set(ph.map(p => p.id));
  try { await delMany([...S.anns.filter(a => pid.has(a.photo)).map(a => ["anns", a.id]), ...ph.flatMap(p => [["photos", p.id], ["blobs", p.id]]), ["tabs", t.id]]); } catch (e) { return; }
  ph.forEach(p => dropUrls(p.id));
  S.anns = S.anns.filter(a => a.tab !== t.id); S.photos = S.photos.filter(p => p.tab !== t.id); S.tabs = S.tabs.filter(x => x.id !== t.id);
  if (!S.tabs.length) await addTab("Geral");
  cur.dirty = false; cur.tab = S.tabs.slice().sort(byDate)[0].id; cur.photo = (photosOf()[0] || {}).id || null; cur.sel = null; renderAll();
};

/* fotos */
$("#pAdd").onclick = () => $("#fPh").click();
$("#fPh").onchange = e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) addFiles(f); };
$("#pRen").onclick = async () => {
  const p = curPhoto(); if (!p) return;
  const n = await ask("Renomear foto", { label: "Nome da foto", value: p.name, ok: "Salvar" });
  if (n) { const o = p.name; p.name = n; try { await put("photos", p); } catch (e) { p.name = o; } renderAll(); }
};
$("#pDel").onclick = async () => {
  const p = curPhoto(); if (!p) return;
  const na = S.anns.filter(a => a.photo === p.id).length;
  if (!(await ask("Excluir foto?", { msg: "“" + p.name + "” e suas " + na + " marcação(ões) irão para a lixeira (ficam 30 dias).", ok: "Excluir", danger: true }))) return;
  const pa = S.anns.filter(x => x.photo === p.id); let rec;
  try {
    await withBlob(p); const { blob, ...meta } = p;
    rec = { id: uid(), kind: "photo", at: now(), name: p.name, data: { meta, blob, anns: pa } };
    await delMany([...pa.map(a => ["anns", a.id]), ["photos", p.id], ["blobs", p.id]], [["trash", rec]]);
  } catch (e) { toast("Não foi possível excluir: " + msg(e), true); return; }
  S.trash.push(rec);
  S.anns = S.anns.filter(a => a.photo !== p.id); S.photos = S.photos.filter(x => x.id !== p.id);
  dropUrls(p.id);
  cur.dirty = false; cur.photo = (photosOf()[0] || {}).id || null; cur.sel = null; $("#img").dataset.id = ""; renderAll();
};
$("#pLoc").onclick = async () => {
  const p = curPhoto(); if (!p) return;
  const legacy = p.loc && !addrParse(p.loc);
  const r = await askAddr("Local e fileira", "O título da foto passa a ser o endereço." + (legacy ? " Local atual (formato antigo): " + p.loc + ". Deixe em branco para mantê-lo." : ""), p.loc, "Salvar", [{ label: "Fileira", value: p.layer || "" }]);
  if (!r) return;
  const o = { loc: p.loc, layer: p.layer }; p.loc = r.loc || (legacy ? p.loc : ""); p.layer = r.rest[0];
  try { await put("photos", p); } catch (e) { Object.assign(p, o); }
  renderAll();
};
$("#pMvL").onclick = () => movePhoto(-1); $("#pMvR").onclick = () => movePhoto(1);
$("#pPrev").onclick = () => stepPhoto(-1); $("#pNext").onclick = () => stepPhoto(1);

/* zoom, 3D, tela cheia, nova marcação */
$("#zIn").onclick = () => setZoom(cur.zoom * 1.25);
$("#zOut").onclick = () => setZoom(cur.zoom / 1.25);
$("#zFit").onclick = () => { cur.zoom = fitZoom(); applyZoom(); const st = $("#stage"); st.scrollLeft = 0; st.scrollTop = 0; };
$("#zCtr").onclick = () => {
  const a = annOf(cur.sel) || S.anns.filter(x => x.photo === cur.photo && !x.hidden).sort(byDate)[0];
  if (!a) { toast("Esta foto ainda não tem marcações."); return; }
  centerOn(a);
};
$("#stage").addEventListener("wheel", e => { /* Ctrl/⌘ + roda do mouse: zoom no ponto do cursor */
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const r = $("#stage").getBoundingClientRect();
  setZoom(cur.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
}, { passive: false });
(function box3d() {
  let on = true;
  try { on = localStorage.getItem("fl-3d") !== "0"; } catch (e) { /* preferência opcional */ }
  const apply = () => { document.body.classList.toggle("no3d", !on); $("#b3t").setAttribute("aria-pressed", String(on)); };
  $("#b3t").onclick = () => { on = !on; try { localStorage.setItem("fl-3d", on ? "1" : "0"); } catch (e) { /* preferência opcional */ } apply(); };
  apply();
})();
$("#fs").onclick = () => cur.fs ? exitFs() : enterFs();
$("#fsExit").onclick = () => exitFs();
$("#aNew").onclick = async () => {
  if (cur.mode === "draw") { cur.mode = null; toast("Desenho cancelado"); }
  else if (await guard()) { cur.mode = "draw"; toast("Arraste o dedo/mouse sobre a foto para desenhar a marcação"); if (!cur.fs) $("#stage").scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  renderViewer();
};
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || $("#dlg").open) return;
  if (cur.mode === "draw") { cur.mode = null; renderViewer(); }
  else if (cur.fs) exitFs();
});

/* arrastar e soltar fotos */
(function dnd() {
  const box = $("#tabsCard"); let depth = 0;
  const has = e => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  box.addEventListener("dragenter", e => { if (has(e)) { e.preventDefault(); depth++; box.classList.add("drop"); } });
  box.addEventListener("dragover", e => { if (has(e)) e.preventDefault(); });
  box.addEventListener("dragleave", e => { if (has(e) && --depth <= 0) { depth = 0; box.classList.remove("drop"); } });
  box.addEventListener("drop", e => {
    if (!has(e)) return;
    e.preventDefault(); depth = 0; box.classList.remove("drop");
    const f = [...e.dataTransfer.files]; if (f.length) addFiles(f); else toast("Nenhum arquivo solto.", true);
  });
  for (const t of ["dragover", "drop"]) window.addEventListener(t, e => { if (has(e) && !box.contains(e.target)) e.preventDefault(); });
})();

function renderAll() {
  $("#bTrash").textContent = "Lixeira (" + S.trash.length + ")";
  for (const fn of [renderTabs, renderThumbs, renderViewer, renderEditor]) { try { fn(); } catch (e) { console.error(e); toast("Erro ao montar a tela: " + msg(e), true); } } /* uma falha não impede o resto */
  try { if ($("#q").value.trim()) renderResults($("#q").value); } catch (e) { console.error(e); }
}

/* ============================================================ 15. INÍCIO */
(async function init() {
  try { if (history.state && history.state.fs) history.replaceState(null, ""); } catch (e) { /* sem histórico */ }
  try {
    db = await openDB();
    [S.tabs, S.photos, S.anns] = await Promise.all(META.map(dbAll));
    S.trash = await dbAll("trash");
    S.anns.forEach(fixAnn);
    if (!S.tabs.length) await addTab("Estoque");
    await migrateOrder();
    const old = S.trash.filter(t => Date.now() - Date.parse(t.at) > 30 * 864e5);
    if (old.length) { try { await delMany(old.map(t => ["trash", t.id])); S.trash = S.trash.filter(t => !old.includes(t)); } catch (e) { /* tenta na próxima abertura */ } }
  } catch (e) {
    toast("Armazenamento local indisponível — nada será salvo: " + msg(e), true);
    if (!S.tabs.length) S.tabs.push({ id: uid(), name: "Estoque", created: now(), updated: now() });
  }
  cur.tab = S.tabs.slice().sort(byDate)[0].id; cur.photo = (photosOf()[0] || {}).id || null;
  renderAll();
  ensureThumbs();
  storageInfo();
})();
