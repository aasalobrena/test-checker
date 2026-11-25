/* Corrector de exámenes – lógica de la aplicación */
'use strict';

const APP_VERSION = '1.1.1';
const PENALTY = 0.33; // cada fallo resta 0,33 (no un tercio)
const NQ = 80;
const LETTERS = 'ABCD';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Almacenamiento local
// ---------------------------------------------------------------------------
const store = {
  get(key, def) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) {
      toast('No se ha podido guardar en este navegador (¿modo privado o almacenamiento lleno?).');
      return false;
    }
  },
};

const state = {
  keys: store.get('tc.keys', []),
  history: store.get('tc.history', []),
  settings: Object.assign({ allowNegative: false }, store.get('tc.settings', {})),
  activeKeyId: store.get('tc.activeKey', null),
  current: null, // resultado que se está revisando
};

function saveKeys() { store.set('tc.keys', state.keys); }
function saveHistory() { store.set('tc.history', state.history); }
function saveSettings() { store.set('tc.settings', state.settings); }
function setActiveKey(id) { state.activeKeyId = id; store.set('tc.activeKey', id); }
function getKey(id) { return state.keys.find((k) => k.id === id) || null; }
function activeKey() {
  let k = getKey(state.activeKeyId);
  if (!k && state.keys.length) { k = state.keys[0]; setActiveKey(k.id); }
  return k;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ---------------------------------------------------------------------------
// Utilidades de interfaz
// ---------------------------------------------------------------------------
function fmt(x, dec = 2) {
  return Number(x).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function show(el, on = true) { (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on); }

function gotoView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tabbar button').forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (name === 'scan') renderScanHeader();
  if (name === 'keys') renderKeysList();
  if (name === 'history') renderHistory();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Motor de visión (Web Worker)
// ---------------------------------------------------------------------------
const engine = {
  worker: null,
  ready: false,
  seq: 0,
  pending: new Map(),
  init() {
    const st = $('#engine-status');
    try {
      this.worker = new Worker('js/worker.js');
    } catch (e) {
      st.textContent = 'Motor no disponible';
      st.classList.add('error');
      return;
    }
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready') {
        this.ready = true;
        st.textContent = 'Listo';
        st.classList.add('ready');
        renderScanHeader();
      } else if (m.type === 'result') {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p(m.result); }
      }
    };
    this.worker.onerror = (e) => {
      st.textContent = 'Error del motor';
      st.classList.add('error');
      console.error(e);
      for (const [, p] of this.pending) p({ ok: false, found: false, error: 'El motor de visión ha fallado. Recarga la página.' });
      this.pending.clear();
    };
  },
  call(type, img, options) {
    return new Promise((resolve) => {
      if (!this.worker) { resolve({ ok: false, error: 'El motor de visión no está disponible.' }); return; }
      const id = ++this.seq;
      this.pending.set(id, resolve);
      const buffer = img.data.buffer;
      this.worker.postMessage({ type, id, buffer, width: img.width, height: img.height, options: options || {} }, [buffer]);
    });
  },
};

// Convierte un archivo de imagen en ImageData (lado mayor <= maxSide)
async function fileToImageData(file, maxSide = 2400) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    src = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se puede abrir la imagen')); };
      im.src = url;
    });
  }
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  return ctx.getImageData(0, 0, w, h);
}

// ---------------------------------------------------------------------------
// Corrección
// ---------------------------------------------------------------------------
/**
 * marks: array de 80 arrays [bool,bool,bool,bool]
 * Devuelve recuento y estado por pregunta.
 */
function grade(key, marks) {
  const n = key.n;
  let ok = 0, bad = 0, blank = 0, voided = 0;
  const per = [];
  for (let q = 0; q < NQ; q++) {
    const sel = marks[q] ? marks[q].map((m, i) => (m ? LETTERS[i] : '')).join('') : '';
    if (q >= n) { per.push({ status: 'ignored', sel }); continue; }
    const k = key.answers[q];
    if (k === 'X') { voided++; per.push({ status: 'void', sel }); continue; }
    if (sel === '') { blank++; per.push({ status: 'blank', sel }); }
    else if (sel === k) { ok++; per.push({ status: 'ok', sel }); }
    else { bad++; per.push({ status: 'bad', sel, multi: sel.length > 1 }); }
  }
  const total = n - voided;
  let points = ok - PENALTY * bad;
  points = Math.round(points * 100) / 100;
  if (!state.settings.allowNegative && points < 0) points = 0;
  return { ok, bad, blank, voided, total, points, per };
}

function renderScanHeader() {
  const sel = $('#scan-key');
  const k = activeKey();
  sel.innerHTML = state.keys.map((x) => `<option value="${esc(x.id)}"${k && x.id === k.id ? ' selected' : ''}>${esc(x.name)}${x.code ? ' (' + esc(x.code) + ')' : ''}</option>`).join('');
  show('#scan-nokey', !k);
  sel.disabled = !state.keys.length;
  $('#scan-key-info').textContent = k ? keySummary(k) : '';
  const can = !!k && engine.ready;
  $('#btn-camera').disabled = !can;
  $('#btn-photo').classList.toggle('disabled', !can);
  $('#file-input').disabled = !can;
  if (state.current && k && state.current.keyId !== k.id) {
    state.current.keyId = k.id;
    renderResult();
  }
}

function keySummary(k) {
  const voids = k.answers.slice(0, k.n).filter((a) => a === 'X').length;
  return `${k.n} preguntas${voids ? ` · ${voids} anulada${voids > 1 ? 's' : ''}` : ''} · cada fallo resta ${fmt(PENALTY)}`;
}

async function handleAnalyzed(res, mode) {
  if (mode === 'key') { applyKeyScan(res); return; }
  show('#scan-busy', false);
  if (!res.ok) {
    $('#scan-error').textContent = res.error || 'No se ha podido leer la hoja.';
    show('#scan-error', true);
    return;
  }
  const k = activeKey();
  state.current = {
    keyId: k ? k.id : null,
    res,
    marks: res.answers.map((a) => a.marks.slice()),
    doubtful: res.answers.map((a) => a.doubtful),
    dniDigits: res.dni.digits.map((d) => (d === '?' ? '' : d)),
    dniDoubtful: res.dni.doubtful,
    dniEdited: false,
  };
  $('#r-dni').value = res.dni.value;
  $('#r-name').value = '';
  prepareSheetCanvas(res);
  renderResult();
  show('#result', true);
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function processFile(file, mode) {
  if (!file) return;
  if (mode !== 'key') {
    show('#scan-error', false);
    show('#result', false);
    show('#scan-busy', true);
  } else {
    show('#key-scan-msg', false);
    show('#key-scan-busy', true);
  }
  let img;
  try {
    img = await fileToImageData(file);
  } catch (e) {
    const msg = 'No se ha podido abrir la imagen.';
    if (mode === 'key') { show('#key-scan-busy', false); keyScanMsg(msg, 'error'); } else { show('#scan-busy', false); $('#scan-error').textContent = msg; show('#scan-error', true); }
    return;
  }
  const res = await engine.call('analyze', img, {});
  handleAnalyzed(res, mode);
}

function dniString(digits) {
  let last = -1;
  digits.forEach((d, i) => { if (d !== '') last = i; });
  return digits.slice(0, last + 1).map((d) => (d === '' ? '?' : d)).join('');
}

function renderResult() {
  const cur = state.current;
  if (!cur) return;
  const key = getKey(cur.keyId) || activeKey();
  if (!key) return;
  const g = grade(key, cur.marks);
  cur.grade = g;
  $('#r-points').textContent = fmt(g.points);
  $('#r-total').textContent = g.total;
  $('#r-ok').textContent = g.ok;
  $('#r-bad').textContent = g.bad;
  $('#r-blank').textContent = g.blank;
  $('#r-void').textContent = g.voided;
  show('#r-void-box', g.voided > 0);
  $('#r-formula').textContent = `${g.ok} − ${fmt(PENALTY)} × ${g.bad} = ${fmt(g.ok - PENALTY * g.bad)}`;

  // avisos
  const warns = [];
  const doubts = [];
  for (let q = 0; q < key.n; q++) if (cur.doubtful[q]) doubts.push(q + 1);
  if (doubts.length) warns.push(`${doubts.length === 1 ? 'Hay 1 pregunta dudosa' : `Hay ${doubts.length} preguntas dudosas`} (${doubts.join(', ')}). Revisa la imagen y toca la burbuja si hace falta.`);
  const multi = g.per.map((p, i) => (p.multi ? i + 1 : 0)).filter(Boolean);
  if (multi.length) warns.push(`Con varias marcas (cuentan como fallo): ${multi.join(', ')}.`);
  const beyond = [];
  for (let q = key.n; q < NQ; q++) if (cur.marks[q].some(Boolean)) beyond.push(q + 1);
  if (beyond.length) warns.push(`Hay marcas en preguntas que no forman parte de este examen (${beyond.length > 6 ? beyond.slice(0, 6).join(', ') + '…' : beyond.join(', ')}); no se tienen en cuenta.`);
  if (cur.dniDoubtful && !cur.dniEdited) warns.push('El D.N.I. no se ha leído con seguridad: compruébalo.');
  $('#r-warn').innerHTML = warns.map((w) => `<div>${esc(w)}</div>`).join('');
  show('#r-warn', warns.length > 0);

  drawSheet();
  renderAnswerList(key, g);
}

// --- Imagen de revisión -----------------------------------------------------
let baseCanvas = null;
function prepareSheetCanvas(res) {
  baseCanvas = document.createElement('canvas');
  baseCanvas.width = res.display.width;
  baseCanvas.height = res.display.height;
  const id = new ImageData(new Uint8ClampedArray(res.display.data), res.display.width, res.display.height);
  baseCanvas.getContext('2d').putImageData(id, 0, 0);
  const c = $('#sheet-canvas');
  c.width = res.display.width;
  c.height = res.display.height;
}

const COLORS = { ok: '#16a34a', bad: '#dc2626', key: '#0ea5e9', doubt: '#f59e0b', void: '#7c3aed', dni: '#2563eb', neutral: '#475569' };

function drawSheet() {
  const cur = state.current;
  if (!cur || !baseCanvas) return;
  const key = getKey(cur.keyId) || activeKey();
  const g = cur.grade;
  const c = $('#sheet-canvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(baseCanvas, 0, 0);
  const R = cur.res.bubbleRadius;
  const pos = cur.res.positions;
  for (let q = 0; q < NQ; q++) {
    const st = g.per[q].status;
    const row = pos[q];
    if (st === 'ignored') {
      for (let o = 0; o < 4; o++) if (cur.marks[q][o]) circle(ctx, row[o], R, { fill: COLORS.neutral, alpha: 0.35 });
      continue;
    }
    if (st === 'void') {
      const [x0, y0] = row[0], [x1, y1] = row[3];
      ctx.save(); ctx.strokeStyle = COLORS.void; ctx.lineWidth = 3; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(x0 - R * 1.4, y0); ctx.lineTo(x1 + R * 1.4, y1); ctx.stroke(); ctx.restore();
      for (let o = 0; o < 4; o++) if (cur.marks[q][o]) circle(ctx, row[o], R, { fill: COLORS.void, alpha: 0.35 });
      continue;
    }
    const k = key.answers[q];
    for (let o = 0; o < 4; o++) {
      if (cur.marks[q][o]) circle(ctx, row[o], R, { fill: st === 'ok' ? COLORS.ok : COLORS.bad, alpha: 0.45 });
    }
    if (st !== 'ok' && LETTERS.includes(k)) {
      circle(ctx, row[LETTERS.indexOf(k)], R + 3, { stroke: COLORS.key, width: 3.5 });
    }
    if (cur.doubtful[q]) {
      const [x0, y0] = row[0], [x1, y1] = row[3];
      ctx.save(); ctx.strokeStyle = COLORS.doubt; ctx.lineWidth = 3; ctx.setLineDash([7, 5]);
      roundRect(ctx, Math.min(x0, x1) - R - 7, Math.min(y0, y1) - R - 7, Math.abs(x1 - x0) + 2 * R + 14, Math.abs(y1 - y0) + 2 * R + 14, 8);
      ctx.stroke(); ctx.restore();
    }
  }
  // DNI
  const dR = cur.res.dniRadius;
  cur.res.dniPositions.forEach((col, ci) => {
    const d = cur.dniDigits[ci];
    if (d !== '' && d !== undefined) circle(ctx, col[+d], dR + 1, { fill: COLORS.dni, alpha: 0.4 });
  });
}

function circle(ctx, [x, y], r, o) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (o.fill) { ctx.globalAlpha = o.alpha == null ? 1 : o.alpha; ctx.fillStyle = o.fill; ctx.fill(); ctx.globalAlpha = 1; }
  if (o.stroke) { ctx.strokeStyle = o.stroke; ctx.lineWidth = o.width || 2; ctx.stroke(); }
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function onSheetTap(ev) {
  const cur = state.current;
  if (!cur) return;
  const c = ev.currentTarget;
  const rect = c.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * (c.width / rect.width);
  const y = (ev.clientY - rect.top) * (c.height / rect.height);
  let best = null, bd = Infinity;
  cur.res.positions.forEach((row, q) => row.forEach(([u, v], o) => {
    const d = Math.hypot(u - x, v - y);
    if (d < bd) { bd = d; best = { kind: 'q', q, o }; }
  }));
  cur.res.dniPositions.forEach((col, ci) => col.forEach(([u, v], d) => {
    const dd = Math.hypot(u - x, v - y);
    if (dd < bd) { bd = dd; best = { kind: 'dni', c: ci, d }; }
  }));
  const lim = (best && best.kind === 'dni' ? cur.res.dniRadius : cur.res.bubbleRadius) * 1.6;
  if (!best || bd > lim) return;
  if (best.kind === 'q') toggleMark(best.q, best.o);
  else {
    cur.dniDigits[best.c] = cur.dniDigits[best.c] === String(best.d) ? '' : String(best.d);
    cur.dniEdited = true;
    $('#r-dni').value = dniString(cur.dniDigits);
    renderResult();
  }
}

function toggleMark(q, o) {
  const cur = state.current;
  cur.marks[q][o] = !cur.marks[q][o];
  cur.doubtful[q] = false; // revisada a mano
  renderResult();
}

function renderAnswerList(key, g) {
  const cur = state.current;
  const html = [];
  for (let q = 0; q < key.n; q++) {
    const st = g.per[q].status;
    const k = key.answers[q];
    const cls = ['ans', st === 'ok' ? 'ok' : st === 'bad' ? 'bad' : st === 'void' ? 'void' : '', cur.doubtful[q] ? 'doubt' : ''].join(' ');
    html.push(`<div class="${cls}" data-q="${q}"><span class="qn">${q + 1}</span>` +
      [0, 1, 2, 3].map((o) => `<button type="button" data-o="${o}" class="${cur.marks[q][o] ? 'on' : ''} ${k === LETTERS[o] ? 'key' : ''}" aria-pressed="${cur.marks[q][o]}" aria-label="Pregunta ${q + 1} opción ${LETTERS[o]}">${LETTERS[o]}</button>`).join('') +
      `${k === 'X' ? '<small class="muted">anulada</small>' : ''}</div>`);
  }
  $('#answers-list').innerHTML = html.join('');
}

function saveCurrent(next) {
  const cur = state.current;
  if (!cur) return;
  const key = getKey(cur.keyId) || activeKey();
  const g = grade(key, cur.marks);
  const dni = $('#r-dni').value.trim().toUpperCase();
  const name = $('#r-name').value.trim();
  if (dni) {
    const dupIdx = state.history.findIndex((h) => h.keyId === key.id && h.dni === dni);
    if (dupIdx >= 0) {
      if (!confirm(`Ya hay un resultado guardado para el D.N.I. ${dni} en este examen. ¿Quieres reemplazarlo?`)) return;
      state.history.splice(dupIdx, 1);
    }
  }
  state.history.unshift({
    id: uid(),
    date: new Date().toISOString(),
    keyId: key.id,
    keyName: key.name,
    keyCode: key.code || '',
    n: key.n,
    dni,
    name,
    ok: g.ok,
    bad: g.bad,
    blank: g.blank,
    voided: g.voided,
    total: g.total,
    points: g.points,
    answers: cur.marks.slice(0, key.n).map((m) => m.map((b, i) => (b ? LETTERS[i] : '')).join('')),
  });
  saveHistory();
  toast(`Guardado: ${fmt(g.points)} / ${g.total}`);
  discardCurrent();
  if (next) openCamera('grade');
}

function discardCurrent() {
  state.current = null;
  show('#result', false);
  show('#scan-error', false);
}

// ---------------------------------------------------------------------------
// Cámara en vivo
// ---------------------------------------------------------------------------
const cam = {
  stream: null, mode: 'grade', running: false, busy: false, stable: 0, lastQuad: null,
  pauseUntil: 0, lastLocate: 0, analyzing: false, quad: null, found: false,
};

async function openCamera(mode) {
  if (!engine.ready) { toast('El motor de visión aún se está cargando…'); return; }
  cam.mode = mode;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    fallbackPhoto(mode, 'Este navegador no permite usar la cámara en directo. Usa una foto.');
    return;
  }
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } },
    });
  } catch (e) {
    fallbackPhoto(mode, 'No se ha podido abrir la cámara (¿permiso denegado?). Puedes usar una foto.');
    return;
  }
  const v = $('#cam-video');
  v.srcObject = cam.stream;
  try { await v.play(); } catch (e) { /* autoplay */ }
  show('#camera', true);
  document.body.style.overflow = 'hidden';
  cam.running = true; cam.busy = false; cam.stable = 0; cam.lastQuad = null; cam.quad = null; cam.found = false;
  cam.pauseUntil = performance.now() + 600;
  setHint(mode === 'key' ? 'Encuadra la hoja con las soluciones' : 'Encuadra la hoja completa');
  requestAnimationFrame(camLoop);
}

function fallbackPhoto(mode, msg) {
  toast(msg, 3500);
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
  inp.onchange = () => processFile(inp.files[0], mode);
  inp.click();
}

function closeCamera() {
  cam.running = false;
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  show('#camera', false);
  document.body.style.overflow = '';
  const $sh = $('#cam-shot');
  $sh.classList.remove('busy');
}

function setHint(text, good) {
  const h = $('#cam-hint');
  h.textContent = text;
  h.classList.toggle('good', !!good);
}

function grabFrame(maxSide) {
  const v = $('#cam-video');
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return null;
  const s = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.round(vw * s), h = Math.round(vh * s);
  const c = grabFrame.canvas || (grabFrame.canvas = document.createElement('canvas'));
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, w, h);
  return { img: ctx.getImageData(0, 0, w, h), scale: s };
}

function drawCamOverlay() {
  const v = $('#cam-video');
  const c = $('#cam-overlay');
  const dpr = window.devicePixelRatio || 1;
  const cw = c.clientWidth, ch = c.clientHeight;
  if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw) return;
  const s = Math.min(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  if (cam.quad) {
    ctx.beginPath();
    cam.quad.forEach(([x, y], i) => { const X = ox + x * s, Y = oy + y * s; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
    ctx.closePath();
    ctx.lineWidth = 4;
    ctx.strokeStyle = cam.found ? (cam.stable >= 2 ? '#22c55e' : '#facc15') : 'rgba(255,255,255,.4)';
    ctx.fillStyle = cam.found ? 'rgba(34,197,94,.12)' : 'transparent';
    ctx.fill(); ctx.stroke();
  }
}

function quadMove(a, b) {
  if (!a || !b) return Infinity;
  const size = Math.hypot(a[0][0] - a[2][0], a[0][1] - a[2][1]) || 1;
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m / size;
}

async function camLoop() {
  if (!cam.running) return;
  drawCamOverlay();
  const now = performance.now();
  if (!cam.busy && now - cam.lastLocate > 180 && now > cam.pauseUntil) {
    cam.busy = true;
    cam.lastLocate = now;
    const fr = grabFrame(720);
    if (fr) {
      const r = await engine.call('locate', fr.img, {});
      if (!cam.running) return;
      if (r && r.page) {
        const quad = r.page.map(([x, y]) => [x / fr.scale, y / fr.scale]);
        cam.found = !!r.found;
        if (cam.found && quadMove(quad, cam.lastQuad) < 0.03) cam.stable++;
        else cam.stable = cam.found ? 1 : 0;
        cam.lastQuad = quad;
        cam.quad = quad;
      } else {
        cam.found = false; cam.stable = 0; cam.quad = null;
      }
      if (!cam.analyzing) {
        if (cam.found && cam.stable >= 3) {
          await captureAndAnalyze();
        } else if (cam.found) setHint('No te muevas…', true);
        else setHint(cam.mode === 'key' ? 'Encuadra la hoja con las soluciones' : 'Encuadra la hoja completa');
      }
    }
    cam.busy = false;
  }
  requestAnimationFrame(camLoop);
}

async function captureAndAnalyze() {
  if (cam.analyzing || !cam.running) return;
  cam.analyzing = true;
  $('#cam-shot').classList.add('busy');
  setHint('Leyendo…', true);
  const fr = grabFrame(2400);
  let res = null;
  if (fr) res = await engine.call('analyze', fr.img, {});
  $('#cam-shot').classList.remove('busy');
  cam.analyzing = false;
  if (!cam.running) return;
  if (res && res.ok) {
    if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) { /* nada */ } }
    const mode = cam.mode;
    closeCamera();
    if (mode === 'key') { show('#key-scan-busy', false); }
    handleAnalyzed(res, mode);
  } else {
    setHint('No se ha podido leer. Acerca la cámara, evita sombras y que se vea toda la hoja.');
    cam.stable = 0;
    cam.pauseUntil = performance.now() + 1200;
  }
}

// ---------------------------------------------------------------------------
// Solucionarios
// ---------------------------------------------------------------------------
const editor = { id: null, answers: new Array(NQ).fill(''), n: 80 };

function parseKeyText(text) {
  const out = [];
  for (const ch of String(text).toUpperCase()) {
    if ('ABCD'.includes(ch)) out.push(ch);
    else if (ch === 'X' || ch === '-' || ch === '*') out.push('X');
    else if (ch === '?' || ch === '_') out.push('');
    // el resto (espacios, números, comas, paréntesis…) se ignora
  }
  return out;
}
function keyToText(answers, n) {
  const parts = [];
  for (let q = 0; q < n; q++) parts.push(answers[q] === '' ? '_' : answers[q]);
  let s = '';
  for (let i = 0; i < parts.length; i++) { if (i && i % 5 === 0) s += ' '; s += parts[i]; }
  return s;
}

function renderKeysList() {
  const list = $('#keys-list');
  const act = activeKey();
  list.innerHTML = state.keys.map((k) => {
    const nh = state.history.filter((h) => h.keyId === k.id).length;
    return `<li data-id="${esc(k.id)}">
      <div class="li-head"><span class="li-title">${esc(k.name)}</span>${act && act.id === k.id ? '<span class="badge">en uso</span>' : ''}</div>
      <div class="li-sub">${k.code ? 'Código ' + esc(k.code) + ' · ' : ''}${esc(keySummary(k))}${nh ? ` · ${nh} corregido${nh > 1 ? 's' : ''}` : ''}</div>
      <div class="li-keys">${esc(keyToText(k.answers, k.n))}</div>
      <div class="btn-row">
        <button class="btn primary" data-act="use">Corregir con este</button>
        <button class="btn" data-act="edit">Editar</button>
        <button class="btn" data-act="share">Pasar al móvil</button>
        <button class="btn" data-act="dup">Duplicar</button>
        <button class="btn ghost danger" data-act="del">Borrar</button>
      </div></li>`;
  }).join('');
  show('#keys-empty', !state.keys.length);
}

function openEditor(k, copy) {
  editor.id = k && !copy ? k.id : null;
  editor.n = k ? k.n : 80;
  editor.answers = k ? k.answers.slice() : new Array(NQ).fill('');
  while (editor.answers.length < NQ) editor.answers.push('');
  $('#k-name').value = k ? (copy ? k.name + ' (copia)' : k.name) : '';
  $('#k-code').value = k ? k.code || '' : '';
  $('#k-n').value = editor.n;
  $('#k-text').value = k ? keyToText(editor.answers, editor.n) : '';
  $('#key-editor-title').textContent = editor.id ? 'Editar solucionario' : 'Nuevo solucionario';
  show('#btn-key-share', !!editor.id);
  show('#key-scan-msg', false);
  show('#keys-list-wrap', false);
  show('#key-editor', true);
  renderKeyGrid();
  window.scrollTo(0, 0);
}
function closeEditor() {
  show('#key-editor', false);
  show('#keys-list-wrap', true);
  renderKeysList();
}

function renderKeyGrid() {
  const n = editor.n;
  const html = [];
  for (let q = 0; q < n; q++) {
    const a = editor.answers[q];
    html.push(`<div class="kq${a === '' ? ' missing' : ''}" data-q="${q}"><span class="qn">${q + 1}</span>` +
      LETTERS.split('').map((L) => `<button type="button" data-v="${L}" class="${a === L ? 'on' : ''}" aria-pressed="${a === L}">${L}</button>`).join('') +
      `<button type="button" data-v="X" class="x ${a === 'X' ? 'on' : ''}" title="Anulada" aria-pressed="${a === 'X'}">✕</button></div>`);
  }
  $('#k-grid').innerHTML = html.join('');
  updateKeyStatus();
}

function updateKeyStatus() {
  const n = editor.n;
  const ans = editor.answers.slice(0, n);
  const missing = [];
  ans.forEach((a, i) => { if (a === '') missing.push(i + 1); });
  const voids = ans.filter((a) => a === 'X').length;
  const st = $('#k-status');
  if (missing.length) {
    st.textContent = `Faltan ${missing.length} de ${n}: ${missing.length > 12 ? missing.slice(0, 12).join(', ') + '…' : missing.join(', ')}`;
    st.className = 'status bad';
  } else {
    st.textContent = `✓ ${n} respuestas definidas${voids ? ` (${voids} anulada${voids > 1 ? 's' : ''})` : ''}`;
    st.className = 'status ok';
  }
}

function onKeyTextInput() {
  const parsed = parseKeyText($('#k-text').value);
  if (parsed.length > editor.n && editor.n < NQ) {
    editor.n = Math.min(NQ, parsed.length);
    $('#k-n').value = editor.n;
  }
  for (let q = 0; q < NQ; q++) editor.answers[q] = q < parsed.length ? parsed[q] : '';
  renderKeyGrid();
  if (parsed.length > NQ) {
    const st = $('#k-status');
    st.textContent = `Has escrito ${parsed.length} respuestas; la hoja solo tiene ${NQ}. Se ignoran las sobrantes.`;
    st.className = 'status bad';
  }
}

function onKeyGridClick(ev) {
  const b = ev.target.closest('button[data-v]');
  if (!b) return;
  const q = +b.closest('.kq').dataset.q;
  const v = b.dataset.v;
  editor.answers[q] = editor.answers[q] === v ? '' : v;
  $('#k-text').value = keyToText(editor.answers, editor.n);
  renderKeyGrid();
}

function onKeyNChange() {
  let n = parseInt($('#k-n').value, 10);
  if (!(n >= 1)) return;
  n = Math.min(NQ, n);
  editor.n = n;
  $('#k-text').value = keyToText(editor.answers, n);
  renderKeyGrid();
}

function saveEditor() {
  const n = editor.n;
  const ans = editor.answers.slice(0, n);
  const missing = ans.filter((a) => a === '').length;
  if (missing) {
    toast(`Faltan ${missing} respuestas por definir.`);
    updateKeyStatus();
    return;
  }
  if (ans.every((a) => a === 'X')) { toast('Todas las preguntas están anuladas.'); return; }
  let name = $('#k-name').value.trim();
  if (!name) name = 'Examen ' + new Date().toLocaleDateString('es-ES');
  const data = { name, code: $('#k-code').value.trim(), n, answers: ans.concat(new Array(NQ - n).fill('')), updated: new Date().toISOString() };
  if (editor.id) {
    const k = getKey(editor.id);
    Object.assign(k, data);
    // actualizar nombre en el historial
    state.history.forEach((h) => { if (h.keyId === k.id) { h.keyName = k.name; h.keyCode = k.code; } });
    saveHistory();
  } else {
    const k = Object.assign({ id: uid(), created: new Date().toISOString() }, data);
    state.keys.push(k);
    setActiveKey(k.id);
  }
  saveKeys();
  closeEditor();
  const saved = getKey(editor.id) || getKey(state.activeKeyId);
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (saved && !touch) openShare(saved, true); // en el ordenador: mostrar directamente el QR
  else toast('Solucionario guardado');
}

function keyScanMsg(html, kind) {
  const el = $('#key-scan-msg');
  el.innerHTML = html;
  el.className = 'notice ' + (kind || '');
}

function applyKeyScan(res) {
  show('#key-scan-busy', false);
  gotoViewKeepEditor();
  if (!res.ok) { keyScanMsg(esc(res.error || 'No se ha podido leer la hoja.'), 'error'); return; }
  const answers = res.answers.map((a) => (a.marks.filter(Boolean).length === 1 ? LETTERS[a.marks.indexOf(true)] : ''));
  const multi = [], doubt = [];
  res.answers.forEach((a, i) => {
    if (a.marks.filter(Boolean).length > 1) multi.push(i + 1);
    if (a.doubtful) doubt.push(i + 1);
  });
  let last = -1;
  answers.forEach((a, i) => { if (a !== '' || multi.includes(i + 1)) last = i; });
  if (last < 0) { keyScanMsg('No se ha encontrado ninguna respuesta marcada en la hoja.', 'error'); return; }
  editor.n = last + 1;
  editor.answers = answers.concat([]);
  $('#k-n').value = editor.n;
  $('#k-text').value = keyToText(editor.answers, editor.n);
  renderKeyGrid();
  const parts = [`Leídas ${editor.n} preguntas.`];
  const blanks = [];
  for (let q = 0; q < editor.n; q++) if (answers[q] === '' && !multi.includes(q + 1)) blanks.push(q + 1);
  if (blanks.length) parts.push(`Sin marcar (complétalas o anúlalas): ${blanks.join(', ')}.`);
  if (multi.length) parts.push(`Con varias marcas: ${multi.join(', ')}.`);
  if (doubt.length) parts.push(`Dudosas, revísalas: ${doubt.join(', ')}.`);
  parts.push('Comprueba el número de preguntas antes de guardar.');
  keyScanMsg(parts.map(esc).join('<br>'), blanks.length || multi.length || doubt.length ? 'warn' : 'ok');
}
function gotoViewKeepEditor() {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-keys'));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === 'keys'));
  show('#keys-list-wrap', false);
  show('#key-editor', true);
}

function exportKeys() {
  const data = { app: 'corrector-examenes', version: 1, exported: new Date().toISOString(), keys: state.keys };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `solucionarios-${dateStamp()}.json`);
}
async function importKeys(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const arr = Array.isArray(data) ? data : data.keys;
    if (!Array.isArray(arr)) throw new Error('formato');
    let added = 0;
    for (const k of arr) {
      if (!k || !Array.isArray(k.answers) || !(k.n >= 1 && k.n <= NQ)) continue;
      const answers = k.answers.slice(0, NQ).map((a) => (['A', 'B', 'C', 'D', 'X'].includes(a) ? a : ''));
      while (answers.length < NQ) answers.push('');
      const exists = getKey(k.id);
      const nk = { id: exists ? uid() : (k.id || uid()), name: String(k.name || 'Importado'), code: String(k.code || ''), n: k.n, answers, created: k.created || new Date().toISOString() };
      state.keys.push(nk);
      added++;
    }
    saveKeys();
    renderKeysList();
    toast(added ? `Importados ${added} solucionarios` : 'No se ha importado nada');
  } catch (e) {
    toast('El archivo no es una copia de solucionarios válida.');
  }
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
function histFiltered() {
  const f = $('#hist-filter').value;
  return f ? state.history.filter((h) => h.keyId === f) : state.history;
}

function renderHistory() {
  const sel = $('#hist-filter');
  const prev = sel.value;
  const opts = new Map();
  state.keys.forEach((k) => opts.set(k.id, k.name));
  state.history.forEach((h) => { if (!opts.has(h.keyId)) opts.set(h.keyId, h.keyName); });
  sel.innerHTML = '<option value="">Todos los exámenes</option>' + Array.from(opts).map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  if (prev && opts.has(prev)) sel.value = prev;
  const rows = histFiltered();
  $('#hist-body').innerHTML = rows.map((h) => {
    const d = new Date(h.date);
    return `<tr data-id="${esc(h.id)}">
      <td>${d.toLocaleDateString('es-ES')}<div class="sub">${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div></td>
      <td><button class="link" data-act="name" title="Editar nombre">${esc(h.name || '—')}</button><div class="sub">${esc(h.dni || 'sin DNI')}</div></td>
      <td>${esc(h.keyName)}</td>
      <td class="num">${h.ok}</td><td class="num">${h.bad}</td><td class="num">${h.blank}</td>
      <td class="num pts">${fmt(h.points)}<span class="sub"> / ${h.total}</span></td>
      <td><button data-act="del" aria-label="Borrar">🗑</button></td></tr>`;
  }).join('');
  show('#hist-empty', !rows.length);
  const st = $('#hist-stats');
  if (rows.length) {
    const pts = rows.map((h) => h.points);
    const avg = pts.reduce((a, b) => a + b, 0) / pts.length;
    const sameTotal = rows.every((h) => h.total === rows[0].total);
    const tot = sameTotal ? ` / ${rows[0].total}` : '';
    st.innerHTML = `<div class="stat">Hojas <b>${rows.length}</b></div>
      <div class="stat">Media <b>${fmt(avg)}</b>${tot}</div>
      <div class="stat">Máx. <b>${fmt(Math.max(...pts))}</b></div>
      <div class="stat">Mín. <b>${fmt(Math.min(...pts))}</b></div>`;
  } else st.innerHTML = '';
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCsv() {
  const rows = histFiltered();
  if (!rows.length) { toast('No hay resultados que exportar.'); return; }
  const maxN = Math.max(...rows.map((h) => h.n));
  const head = ['Fecha', 'Hora', 'Examen', 'Código', 'Nombre', 'DNI', 'Aciertos', 'Fallos', 'En blanco', 'Anuladas', 'Preguntas', 'Puntos'];
  for (let i = 1; i <= maxN; i++) head.push('P' + i);
  const lines = [head.map(csvCell).join(';')];
  rows.slice().reverse().forEach((h) => {
    const d = new Date(h.date);
    const r = [d.toLocaleDateString('es-ES'), d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }), h.keyName, h.keyCode, h.name, h.dni,
      h.ok, h.bad, h.blank, h.voided, h.total, fmt(h.points)];
    for (let i = 0; i < maxN; i++) r.push(h.answers[i] || '');
    lines.push(r.map(csvCell).join(';'));
  });
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  download(blob, `resultados-${dateStamp()}.csv`);
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------------------------------------------------------------------
// Pasar un solucionario a otro dispositivo (enlace / código QR)
// El solucionario viaja dentro del propio enlace (#k=...): no hay servidor.
// ---------------------------------------------------------------------------
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function shareUrl(k) {
  const payload = { v: 1, name: k.name, code: k.code || '', n: k.n, a: k.answers.slice(0, k.n).join('') };
  return location.origin + location.pathname + '#k=' + b64urlEncode(JSON.stringify(payload));
}
let shareCurrent = '';
function openShare(k, justSaved) {
  shareCurrent = shareUrl(k);
  $('#share-title').textContent = justSaved ? '✓ Guardado. Pásalo al móvil' : 'Pasar al móvil';
  $('#share-name').textContent = k.name;
  const box = $('#share-qr');
  try {
    const qr = qrcode(0, 'M');
    qr.addData(shareCurrent);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  } catch (e) {
    box.innerHTML = '<p class="small" style="color:#111">No se ha podido generar el código QR. Usa «Copiar enlace».</p>';
  }
  show('#share-native', !!navigator.share);
  show('#share', true);
}
function closeShare() { show('#share', false); }

function importFromHash() {
  const m = /^#k=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  let d;
  try { d = JSON.parse(b64urlDecode(m[1])); } catch (e) { d = null; }
  const n = d && parseInt(d.n, 10);
  const a = d && typeof d.a === 'string' ? d.a.toUpperCase() : '';
  if (!d || !(n >= 1 && n <= NQ) || a.length !== n || !/^[ABCDX]+$/.test(a)) {
    toast('El enlace del solucionario no es válido o está incompleto.', 4000);
    return;
  }
  const answers = a.split('').concat(new Array(NQ - n).fill(''));
  const name = String(d.name || 'Solucionario importado').slice(0, 120);
  const code = String(d.code || '').slice(0, 60);
  const same = state.keys.find((k) => k.n === n && k.name === name && k.answers.slice(0, n).join('') === a);
  if (same) {
    setActiveKey(same.id);
    toast(`Ya tenías el solucionario «${name}». Queda seleccionado.`, 3500);
    return;
  }
  const k = { id: uid(), name, code, n, answers, created: new Date().toISOString() };
  state.keys.push(k);
  saveKeys();
  setActiveKey(k.id);
  toast(`Solucionario «${name}» añadido y seleccionado.`, 3500);
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
function bind() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => gotoView(b.dataset.view)));
  document.addEventListener('click', (ev) => {
    const g = ev.target.closest('[data-goto]');
    if (g) { gotoView(g.dataset.goto); if (g.dataset.goto === 'keys') openEditor(null); }
  });

  // Corregir
  $('#scan-key').addEventListener('change', (e) => { setActiveKey(e.target.value); renderScanHeader(); });
  $('#btn-camera').addEventListener('click', () => openCamera('grade'));
  $('#file-input').addEventListener('change', (e) => { processFile(e.target.files[0], 'grade'); e.target.value = ''; });
  $('#sheet-canvas').addEventListener('click', onSheetTap);
  $('#answers-list').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-o]');
    if (!b) return;
    toggleMark(+b.closest('.ans').dataset.q, +b.dataset.o);
  });
  $('#r-dni').addEventListener('input', () => { if (state.current) { state.current.dniEdited = true; } });
  $('#btn-save').addEventListener('click', () => saveCurrent(false));
  $('#btn-save-next').addEventListener('click', () => saveCurrent(true));
  $('#btn-discard').addEventListener('click', discardCurrent);

  // Cámara
  $('#cam-close').addEventListener('click', closeCamera);
  $('#cam-shot').addEventListener('click', () => captureAndAnalyze());
  $('#cam-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    const mode = cam.mode;
    e.target.value = '';
    closeCamera();
    processFile(f, mode);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (cam.running) closeCamera();
    closeShare();
  });

  // Solucionarios
  $('#btn-new-key').addEventListener('click', () => openEditor(null));
  $('#btn-key-cancel').addEventListener('click', closeEditor);
  $('#btn-key-save').addEventListener('click', saveEditor);
  $('#btn-key-share').addEventListener('click', () => { const k = getKey(editor.id); if (k) openShare(k); });
  $('#k-text').addEventListener('input', onKeyTextInput);
  $('#k-n').addEventListener('change', onKeyNChange);
  $('#k-n').addEventListener('input', onKeyNChange);
  $('#k-grid').addEventListener('click', onKeyGridClick);
  $('#btn-key-scan').addEventListener('click', () => openCamera('key'));
  $('#keys-list').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('li').dataset.id;
    const k = getKey(id);
    if (!k) return;
    if (b.dataset.act === 'use') { setActiveKey(id); gotoView('scan'); }
    else if (b.dataset.act === 'edit') openEditor(k);
    else if (b.dataset.act === 'dup') openEditor(k, true);
    else if (b.dataset.act === 'share') openShare(k);
    else if (b.dataset.act === 'del') {
      if (!confirm(`¿Borrar el solucionario «${k.name}»? Los resultados guardados en el historial se conservan.`)) return;
      state.keys = state.keys.filter((x) => x.id !== id);
      if (state.activeKeyId === id) setActiveKey(state.keys[0] ? state.keys[0].id : null);
      saveKeys();
      renderKeysList();
    }
  });
  $('#btn-export-keys').addEventListener('click', exportKeys);
  $('#import-keys').addEventListener('change', (e) => { importKeys(e.target.files[0]); e.target.value = ''; });

  // Pasar al móvil
  $('#share-close').addEventListener('click', closeShare);
  $('#share').addEventListener('click', (e) => { if (e.target.id === 'share') closeShare(); });
  $('#share-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(shareCurrent); toast('Enlace copiado'); } catch (e) { prompt('Copia este enlace:', shareCurrent); }
  });
  $('#share-native').addEventListener('click', () => {
    navigator.share({ title: 'Solucionario', url: shareCurrent }).catch(() => {});
  });
  window.addEventListener('hashchange', () => { importFromHash(); gotoView('scan'); });

  // Historial
  $('#hist-filter').addEventListener('change', renderHistory);
  $('#btn-export-csv').addEventListener('click', exportCsv);
  $('#btn-clear-hist').addEventListener('click', () => {
    const rows = histFiltered();
    if (!rows.length) return;
    const f = $('#hist-filter').value;
    if (!confirm(f ? `¿Borrar los ${rows.length} resultados de este examen?` : `¿Borrar los ${rows.length} resultados del historial?`)) return;
    const ids = new Set(rows.map((h) => h.id));
    state.history = state.history.filter((h) => !ids.has(h.id));
    saveHistory();
    renderHistory();
  });
  $('#hist-body').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('tr').dataset.id;
    const h = state.history.find((x) => x.id === id);
    if (!h) return;
    if (b.dataset.act === 'del') {
      if (!confirm('¿Borrar este resultado?')) return;
      state.history = state.history.filter((x) => x.id !== id);
    } else if (b.dataset.act === 'name') {
      const v = prompt('Nombre del alumno/a', h.name || '');
      if (v === null) return;
      h.name = v.trim();
      const dni = prompt('D.N.I.', h.dni || '');
      if (dni !== null) h.dni = dni.trim().toUpperCase();
    }
    saveHistory();
    renderHistory();
  });

  // Ajustes
  $('#set-negative').checked = !!state.settings.allowNegative;
  $('#set-negative').addEventListener('change', (e) => {
    state.settings.allowNegative = e.target.checked;
    saveSettings();
    if (state.current) renderResult();
  });
  $('#app-version').textContent = `Versión ${APP_VERSION}`;
}

function init() {
  importFromHash();
  bind();
  engine.init();
  renderScanHeader();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* sin modo offline */ });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
