/*
 * Motor de reconocimiento óptico de marcas (OMR) para la hoja de respuestas
 * de 80 preguntas (A-D) con D.N.I.
 *
 * Funciona en el navegador (window.OMR) y en Node (module.exports) para tests.
 * Necesita OpenCV.js (objeto `cv`).
 *
 * Estrategia:
 *  1. Buscar cuadriláteros grandes en la foto (contornos).
 *  2. Para cada cuadrilátero, probar que sea el recuadro "ZONA 2" (con o sin la
 *     cabecera negra) en las 4 orientaciones; puntuar cada hipótesis viendo si
 *     hay círculos donde deberían estar las 320 burbujas. Elegir la mejor.
 *  3. Enderezar la hoja completa a un "lienzo canónico" (3 px por punto PDF).
 *  4. Afinar: localizar cada fila de burbujas, ajustar una homografía robusta
 *     (RANSAC) y corregir pequeñas curvaturas fila a fila.
 *  5. Medir cuánto "tinta" hay dentro de cada burbuja y decidir.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OMR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Geometría de la plantilla (en puntos PDF, A4 = 595.276 x 841.89)
  // ---------------------------------------------------------------------------
  const T = {
    pageW: 595.276,
    pageH: 841.89,
    zona: { x0: 53, y0: 268, yInner: 286, x1: 542.28, y1: 811.89 },
    header: { x0: 62, x1: 533, y0: 270.5, y1: 283.5 },
    colX: [100.0, 222.32, 344.64, 466.96],
    rowY: [299.15, 325.44, 351.74, 378.03, 404.33, 430.62, 456.91, 483.21, 509.5, 535.8,
      562.09, 588.39, 614.68, 640.98, 667.27, 693.56, 719.86, 746.15, 772.45, 798.74],
    optDx: 16,
    bubbleR: 6,
    dni: { x0: 449.78, dx: 15, y0: 66, dy: 14.2, cols: 8, r: 4.8 },
    nQuestions: 80,
    nOptions: 5,       // A-E (la E puede no estar impresa en la plantilla de 4 opciones)
  };

  const LETTERS = 'ABCDE';
  function bubblePt(q, o) {
    const c = Math.floor(q / 20), r = q % 20;
    return [T.colX[c] + o * T.optDx, T.rowY[r]];
  }
  function dniPt(c, d) {
    return [T.dni.x0 + c * T.dni.dx, T.dni.y0 + d * T.dni.dy];
  }

  const DEFAULTS = {
    maxDetect: 1400,   // lado mayor de la imagen para la detección
    S: 3,              // píxeles por punto en el lienzo canónico
    displayS: 2,       // píxeles por punto en la imagen de revisión
    markT: 0.30,       // umbral de marca (por encima de la referencia de burbuja vacía)
    weakT: 0.14,       // por encima: marca dudosa
    minSec: 0.33,      // cobertura mínima de los sectores menos cubiertos para ser marca clara
    minQuality: 0.15,  // calidad mínima de alineación para aceptar la lectura
    rowQ: 0.12,        // calidad mínima por fila (si no, la pregunta queda como dudosa)
  };

  // ---------------------------------------------------------------------------
  // Utilidades matemáticas
  // ---------------------------------------------------------------------------
  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }
  function matToArr(m) {
    const d = m.data64F, out = new Array(9);
    for (let i = 0; i < 9; i++) out[i] = d[i];
    return out;
  }
  function homography(cv, src, dst) {
    // src, dst: arrays de 4 [x,y]
    const a = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...src));
    const b = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...dst));
    const M = cv.getPerspectiveTransform(a, b);
    const H = matToArr(M);
    a.delete(); b.delete(); M.delete();
    return H;
  }
  function invertH(H) {
    const [a, b, c, d, e, f, g, h, i] = H;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  function mulH(A, B) { // A·B
    const R = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      R[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
    return R;
  }
  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    const n = s.length;
    if (!n) return 0;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  // Mapa de "oscuridad" (0 = papel, 1 = tinta) normalizando la iluminación.
  function darknessMap(cv, gray, bgScale, bgKernelPx) {
    const w = gray.cols, h = gray.rows;
    const small = new cv.Mat();
    const sw = Math.max(8, Math.round(w * bgScale)), sh = Math.max(8, Math.round(h * bgScale));
    cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(bgKernelPx, bgKernelPx));
    cv.dilate(small, small, k);
    cv.GaussianBlur(small, small, new cv.Size(0, 0), Math.max(1, bgKernelPx / 3));
    const bg = new cv.Mat();
    cv.resize(small, bg, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
    const g = gray.data, b = bg.data, n = w * h;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const bb = b[i];
      if (bb < 25) { out[i] = 0; continue; }
      let v = (bb - g[i]) / bb;
      out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    small.delete(); k.delete(); bg.delete();
    return { data: out, w, h };
  }

  function sample(D, x, y) {
    if (x < 0 || y < 0 || x >= D.w - 1 || y >= D.h - 1) return 0;
    const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * D.w + xi, d = D.data;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + D.w] * (1 - fx) + d[i + D.w + 1] * fx) * fy;
  }

  const RING_N = 20;
  const COS = [], SIN = [];
  for (let i = 0; i < RING_N; i++) { COS.push(Math.cos(2 * Math.PI * i / RING_N)); SIN.push(Math.sin(2 * Math.PI * i / RING_N)); }

  // Contraste de anillo: oscuridad en el borde del círculo menos oscuridad fuera.
  function ringScore(D, x, y, r, rOut) {
    let a = 0, b = 0;
    for (let i = 0; i < RING_N; i++) {
      a += sample(D, x + r * COS[i], y + r * SIN[i]);
      b += sample(D, x + rOut * COS[i], y + rOut * SIN[i]);
    }
    return (a - b) / RING_N;
  }

  // Fracción de tinta dentro de un disco y cobertura mínima por sectores
  // (un relleno cubre todos los sectores; una cruz o un "check" deja huecos).
  function diskInk(D, x, y, r, inkT) {
    let n = 0, ink = 0;
    const secN = new Array(8).fill(0), secI = new Array(8).fill(0);
    const r2 = r * r, ri = Math.ceil(r), rIn = 0.3 * r, rOut = 0.88 * r;
    for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const v = sample(D, x + dx, y + dy) > inkT ? 1 : 0;
      n++; ink += v;
      if (d2 >= rIn * rIn && d2 <= rOut * rOut) {
        const a = Math.atan2(dy, dx);
        const k = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
        secN[k]++; secI[k] += v;
      }
    }
    const sec = secN.map((c, i) => (c ? secI[i] / c : 0)).sort((a, b) => a - b);
    return { frac: n ? ink / n : 0, minSec: (sec[0] + sec[1]) / 2 };
  }

  // ---------------------------------------------------------------------------
  // 1-2. Detección del recuadro ZONA 2
  // ---------------------------------------------------------------------------
  function orderQuad(pts) {
    // ordena en sentido horario empezando por el de arriba-izquierda (coordenadas de imagen)
    const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
    const s = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    // atan2 ordena desde -pi: (arriba-izq aprox. primero en coordenadas de imagen -> ángulo ~ -135º)
    let best = 0, bv = Infinity;
    for (let i = 0; i < 4; i++) { const v = s[i][0] + s[i][1]; if (v < bv) { bv = v; best = i; } }
    return [0, 1, 2, 3].map(i => s[(best + i) % 4]);
  }

  function quadArea(q) {
    let a = 0;
    for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p[0] * n[1] - n[0] * p[1]; }
    return Math.abs(a) / 2;
  }

  function findQuads(cv, gray) {
    const W = gray.cols, H = gray.rows, minArea = 0.03 * W * H;
    const quads = [];
    const blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const bins = [];
    // a) umbral adaptativo
    const b1 = new cv.Mat();
    let block = Math.round(Math.max(W, H) / 45) | 1; if (block < 11) block = 11;
    cv.adaptiveThreshold(blur, b1, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, block, 6);
    const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(b1, b1, cv.MORPH_CLOSE, k3);
    bins.push(b1);
    // b) bordes de Canny (normal y sensible)
    const b2 = new cv.Mat();
    cv.Canny(blur, b2, 40, 120);
    cv.dilate(b2, b2, k3);
    bins.push(b2);
    const b3 = new cv.Mat();
    cv.Canny(blur, b3, 12, 36);
    cv.dilate(b3, b3, k3);
    bins.push(b3);
    // c) umbral global de Otsu (papel claro sobre fondo más oscuro)
    const b4 = new cv.Mat();
    cv.threshold(blur, b4, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    bins.push(b4);
    // d) umbral adaptativo sensible con bloque grande
    const b5 = new cv.Mat();
    cv.adaptiveThreshold(blur, b5, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, (block * 3) | 1, 2);
    cv.morphologyEx(b5, b5, cv.MORPH_CLOSE, k3);
    bins.push(b5);

    for (const bin of bins) {
      const contours = new cv.MatVector(), hier = new cv.Mat();
      cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const hull = new cv.Mat();
        cv.convexHull(c, hull, false, true);
        const area = cv.contourArea(hull);
        if (area >= minArea) {
          const peri = cv.arcLength(hull, true);
          for (const eps of [0.015, 0.03, 0.05]) {
            const ap = new cv.Mat();
            cv.approxPolyDP(hull, ap, eps * peri, true);
            if (ap.rows === 4) {
              const p = [];
              for (let j = 0; j < 4; j++) p.push([ap.data32S[j * 2], ap.data32S[j * 2 + 1]]);
              quads.push(orderQuad(p));
              ap.delete();
              break;
            }
            ap.delete();
          }
        }
        hull.delete(); c.delete();
      }
      contours.delete(); hier.delete();
    }
    blur.delete(); k3.delete();
    for (const b of bins) b.delete();
    // quitar duplicados
    const uniq = [];
    for (const q of quads) {
      const dup = uniq.some(u => u.every((p, i) => Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) < 4));
      if (!dup) uniq.push(q);
    }
    uniq.sort((a, b) => quadArea(b) - quadArea(a));
    return uniq.slice(0, 60);
  }

  // Puntúa una homografía plantilla(pt) -> imagen de detección
  function verifyH(D, H) {
    // escala aproximada px/pt
    const p0 = applyH(H, T.zona.x0, T.zona.y1), p1 = applyH(H, T.zona.x1, T.zona.y1);
    const s = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / (T.zona.x1 - T.zona.x0);
    if (!(s > 0.25)) return -1;
    let ring = 0, n = 0;
    for (let q = 0; q < 80; q++) {
      for (let o = 0; o < 4; o++) {
        const [x, y] = bubblePt(q, o);
        const [u, v] = applyH(H, x, y);
        const [u2, v2] = applyH(H, x + 1, y);
        const sl = Math.hypot(u2 - u, v2 - v);
        ring += ringScore(D, u, v, 6 * sl, 8.3 * sl);
        n++;
      }
    }
    ring /= n;
    // la cabecera negra
    let hd = 0, hn = 0;
    for (let x = T.header.x0; x <= T.header.x1; x += 12) {
      for (let y = T.header.y0; y <= T.header.y1; y += 3) {
        const [u, v] = applyH(H, x, y); hd += sample(D, u, v); hn++;
      }
    }
    hd /= hn;
    // zona blanca encima de la cabecera (instrucciones tiene texto, usamos la franja justo encima)
    return ring + 0.25 * hd;
  }

  function detectZona(cv, gray, D) {
    const quads = findQuads(cv, gray);
    const tplOuter = [[T.zona.x0, T.zona.y0], [T.zona.x1, T.zona.y0], [T.zona.x1, T.zona.y1], [T.zona.x0, T.zona.y1]];
    const tplInner = [[T.zona.x0, T.zona.yInner], [T.zona.x1, T.zona.yInner], [T.zona.x1, T.zona.y1], [T.zona.x0, T.zona.y1]];
    const tplPage = [[0, 0], [T.pageW, 0], [T.pageW, T.pageH], [0, T.pageH]];
    let best = null;
    for (const q of quads) {
      for (const tpl of [tplOuter, tplInner, tplPage]) {
        for (let k = 0; k < 4; k++) {
          const dst = [0, 1, 2, 3].map(i => q[(i + k) % 4]);
          const H = homography(cv, tpl, dst);
          const sc = verifyH(D, H);
          if (!best || sc > best.score) best = { score: sc, H, quad: dst, tpl };
        }
      }
    }
    return { best, nQuads: quads.length };
  }

  // gris = mínimo de los canales (la tinta azul se vuelve oscura)
  function grayFromRGBA(cv, img) {
    const src = img.data;
    const m = new cv.Mat(img.height, img.width, cv.CV_8UC1);
    const gd = m.data;
    for (let i = 0, j = 0; i < gd.length; i++, j += 4) {
      const r = src[j], g = src[j + 1], b = src[j + 2];
      gd[i] = r < g ? (r < b ? r : b) : (g < b ? g : b);
    }
    return m;
  }

  /**
   * Localización rápida (para la vista previa de la cámara).
   * Devuelve las esquinas de la hoja y de ZONA 2 en coordenadas de la imagen.
   */
  function locate(cv, img, options) {
    const opt = Object.assign({}, DEFAULTS, { maxDetect: 640 }, options || {});
    const gray = grayFromRGBA(cv, img);
    const f = Math.min(1, opt.maxDetect / Math.max(img.width, img.height));
    const det = new cv.Mat();
    cv.resize(gray, det, new cv.Size(Math.round(img.width * f), Math.round(img.height * f)), 0, 0, cv.INTER_AREA);
    gray.delete();
    const Ddet = darknessMap(cv, det, 0.25, 7);
    const { best } = detectZona(cv, det, Ddet);
    det.delete();
    if (!best) return { found: false, score: 0 };
    const H = homography(cv, best.tpl, best.quad.map(p => [p[0] / f, p[1] / f]));
    const corners = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => applyH(H, x, y));
    return {
      found: best.score >= 0.12,
      score: best.score,
      page: corners(0, 0, T.pageW, T.pageH),
      zona: corners(T.zona.x0, T.zona.y0, T.zona.x1, T.zona.y1),
    };
  }

  // ---------------------------------------------------------------------------
  // Análisis principal
  // ---------------------------------------------------------------------------
  /**
   * @param cv        OpenCV.js
   * @param img       {data: Uint8ClampedArray RGBA, width, height}
   * @param options   ver DEFAULTS; options.display=false para no generar imagen
   */
  function analyze(cv, img, options) {
    const opt = Object.assign({}, DEFAULTS, options || {});
    const t0 = Date.now();
    const W = img.width, Hh = img.height;
    const grayFull = grayFromRGBA(cv, img);
    // --- detección a baja resolución
    const f = Math.min(1, opt.maxDetect / Math.max(W, Hh));
    const det = new cv.Mat();
    cv.resize(grayFull, det, new cv.Size(Math.round(W * f), Math.round(Hh * f)), 0, 0, cv.INTER_AREA);
    const Ddet = darknessMap(cv, det, 0.25, 7);
    const { best, nQuads } = detectZona(cv, det, Ddet);
    det.delete();
    if (!best || best.score < 0.09) {
      grayFull.delete();
      return { ok: false, error: 'No se ha encontrado la hoja de respuestas en la imagen.', debug: { score: best && best.score, nQuads } };
    }
    // homografía plantilla(pt) -> imagen completa
    const H0 = homography(cv, best.tpl, best.quad.map(p => [p[0] / f, p[1] / f]));

    // --- 3. lienzo canónico
    const S = opt.S;
    const cw = Math.round(T.pageW * S), ch = Math.round(T.pageH * S);
    const toCanon = invertH(mulH(H0, [1 / S, 0, 0, 0, 1 / S, 0, 0, 0, 1])); // imagen -> canon
    const Mw = cv.matFromArray(3, 3, cv.CV_64F, toCanon);
    const canon = new cv.Mat();
    cv.warpPerspective(grayFull, canon, Mw, new cv.Size(cw, ch), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
    Mw.delete();
    grayFull.delete();
    const D = darknessMap(cv, canon, 1 / 6, 9);
    canon.delete();
    // versión suavizada para localizar anillos
    const Ds = blurDark(cv, D, 1.0);

    // --- 4. afinado
    const R = T.bubbleR * S, ROUT = 8.3 * S;
    function rowScore(q, dx, dy, Hc) {
      let s = 0;
      for (let o = 0; o < 4; o++) {
        const [x, y] = bubblePt(q, o);
        const [u, v] = Hc ? applyH(Hc, x * S, y * S) : [x * S, y * S];
        s += ringScore(Ds, u + dx, v + dy, R, ROUT);
      }
      return s;
    }
    function searchRow(q, rad, Hc) {
      let bx = 0, by = 0, bs = -Infinity;
      const step = 2;
      for (let dy = -rad; dy <= rad; dy += step) for (let dx = -rad; dx <= rad; dx += step) {
        const s = rowScore(q, dx, dy, Hc); if (s > bs) { bs = s; bx = dx; by = dy; }
      }
      const cx = bx, cy = by;
      for (let dy = cy - 2; dy <= cy + 2; dy += 0.5) for (let dx = cx - 2; dx <= cx + 2; dx += 0.5) {
        const s = rowScore(q, dx, dy, Hc); if (s > bs) { bs = s; bx = dx; by = dy; }
      }
      return [bx, by, bs];
    }
    const srcPts = [], dstPts = [];
    const rad1 = Math.round(5 * S);
    for (let q = 0; q < 80; q++) {
      const [dx, dy] = searchRow(q, rad1, null);
      for (let o = 0; o < 4; o++) {
        const [x, y] = bubblePt(q, o);
        srcPts.push(x * S, y * S); dstPts.push(x * S + dx, y * S + dy);
      }
    }
    let Hc = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    {
      const a = cv.matFromArray(srcPts.length / 2, 1, cv.CV_32FC2, srcPts);
      const b = cv.matFromArray(dstPts.length / 2, 1, cv.CV_32FC2, dstPts);
      const mask = new cv.Mat();
      const M = cv.findHomography(a, b, cv.RANSAC, 1.5 * S, mask);
      if (M && M.rows === 3) {
        let inl = 0; for (let i = 0; i < mask.rows; i++) inl += mask.data[i] ? 1 : 0;
        if (inl > 120) Hc = matToArr(M);
      }
      if (M) M.delete();
      a.delete(); b.delete(); mask.delete();
    }
    // residuos por fila (curvatura) suavizados por columna
    const resid = [];
    for (let q = 0; q < 80; q++) resid.push(searchRow(q, Math.round(1.5 * S), Hc));
    const pos = []; // posiciones finales (px canon) de cada burbuja
    for (let q = 0; q < 80; q++) {
      const c = Math.floor(q / 20), r = q % 20;
      const nb = [];
      for (let k = Math.max(0, r - 1); k <= Math.min(19, r + 1); k++) nb.push(resid[c * 20 + k]);
      const mx = median(nb.map(v => v[0])), my = median(nb.map(v => v[1]));
      // si el residuo propio se aleja mucho del de sus vecinos, usar la mediana
      let [ox, oy] = resid[q];
      if (Math.hypot(ox - mx, oy - my) > 0.8 * S) { ox = mx; oy = my; }
      const row = [];
      for (let o = 0; o < T.nOptions; o++) {
        const [x, y] = bubblePt(q, o);
        const [u, v] = applyH(Hc, x * S, y * S);
        row.push([u + ox, v + oy]);
      }
      pos.push(row);
    }

    // --- DNI
    const dR = T.dni.r * S, dOut = 6.6 * S;
    function colScoreDni(c, dx, dy) {
      let s = 0;
      for (let d = 0; d < 10; d++) {
        const [x, y] = dniPt(c, d);
        const [u, v] = applyH(Hc, x * S, y * S);
        s += ringScore(Ds, u + dx, v + dy, dR, dOut);
      }
      return s;
    }
    function searchDni(cols, rad, cx0, cy0) {
      let bx = cx0, by = cy0, bs = -Infinity;
      for (let dy = cy0 - rad; dy <= cy0 + rad; dy += 1) for (let dx = cx0 - rad; dx <= cx0 + rad; dx += 1) {
        let s = 0; for (const c of cols) s += colScoreDni(c, dx, dy);
        if (s > bs) { bs = s; bx = dx; by = dy; }
      }
      return [bx, by, bs];
    }
    const allCols = [0, 1, 2, 3, 4, 5, 6, 7];
    const [gdx, gdy] = searchDni(allCols, Math.round(5 * S), 0, 0);
    const dniPos = [];
    for (let c = 0; c < 8; c++) {
      let [dx, dy] = searchDni([c], Math.round(1.2 * S), gdx, gdy);
      const col = [];
      for (let d = 0; d < 10; d++) {
        const [x, y] = dniPt(c, d);
        const [u, v] = applyH(Hc, x * S, y * S);
        col.push([u + dx, v + dy]);
      }
      dniPos.push(col);
    }

    // --- 5. medir tinta
    const inkT = 0.33;
    const inks = pos.map(row => row.map(([u, v]) => diskInk(D, u, v, 4.4 * S, inkT)));
    const fills = inks.map(row => row.map(k => k.frac));
    // calidad de alineación por fila
    const rowQ = pos.map(row => row.slice(0, 4).reduce((acc, [u, v]) => acc + ringScore(Ds, u, v, R, ROUT), 0) / 4);
    // X que sobresale del círculo = respuesta anulada por el alumno (nº de brazos)
    const cancels = pos.map(row => row.map((p, o) => crossedOut(D, row, o, S, inkT)));
    if (opt.debugCancel) opt.debugCancel.push(...pos.map(row => row.map((p, o) => { const d = {}; crossedOut(D, row, o, S, inkT, d); return d; })));
    const dniFills = dniPos.map(col => col.map(([u, v]) => diskInk(D, u, v, 3.3 * S, inkT).frac));
    const allF = [].concat(...fills.map(row => row.slice(0, 4))); // la E puede no estar impresa
    const base = median(allF);
    const dniBase = median([].concat(...dniFills));

    const answers = fills.map((row, i) => classify(row, base, opt, inks[i].map(k => k.minSec), rowQ[i], cancels[i]));
    const dni = readDni(dniFills, dniBase, opt);

    // calidad: contraste medio de anillos con la alineación final
    let q = 0;
    for (const row of pos) for (const [u, v] of row.slice(0, 4)) q += ringScore(Ds, u, v, R, ROUT);
    q /= 320;

    if (q < opt.minQuality) {
      return { ok: false, error: 'No se ha podido alinear la hoja. Haz la foto de nuevo con la hoja completa a la vista, plana y bien iluminada.', debug: { score: best.score, quality: q, nQuads } };
    }
    // imagen de revisión en color
    let display = null;
    if (opt.display !== false) {
      display = warpDisplay(cv, img, H0, opt.displayS);
    }
    const k = opt.displayS / S;
    return {
      ok: true,
      answers, // [{value:'A'|'AB'|'', marks:[bool x5], cancelled:[bool x5], fills:[..], doubtful}]
      dni,
      positions: pos.map(row => row.map(([u, v]) => [u * k, v * k])),
      dniPositions: dniPos.map(col => col.map(([u, v]) => [u * k, v * k])),
      bubbleRadius: T.bubbleR * opt.displayS,
      dniRadius: T.dni.r * opt.displayS,
      display, // {data, width, height} o null
      quality: q,
      debug: { score: best.score, nQuads, base, dniBase, ms: Date.now() - t0, Hc },
    };
  }

  function blurDark(cv, D, sigma) {
    const m = cv.matFromArray(D.h, D.w, cv.CV_32FC1, D.data);
    cv.GaussianBlur(m, m, new cv.Size(0, 0), sigma);
    const out = { data: Float32Array.from(m.data32F), w: D.w, h: D.h };
    m.delete();
    return out;
  }

  function classify(row, base, opt, minSec, rowQ, cancelled) {
    const n = row.length;
    const arms = cancelled || new Array(n).fill(0);
    const canc = arms.map(a => a >= 3);
    const d = row.map(v => v - base);
    // marca clara: suficiente tinta y repartida por todo el círculo (y no tachada)
    const marks = d.map((v, i) => !canc[i] && v >= opt.markT && (!minSec || minSec[i] >= opt.minSec));
    const weak = d.map((v, i) => !canc[i] && v >= opt.weakT && !marks[i]);
    let doubtful = weak.some(Boolean);
    // relleno con 2 "brazos" saliendo: puede ser una X poco marcada
    if (d.some((v, i) => arms[i] === 2 && v >= opt.markT)) doubtful = true;
    let sel = marks.slice();
    if (!marks.some(Boolean) && weak.some(Boolean)) {
      // sin marcas claras: se propone la más oscura (no tachada), pero queda como dudosa
      let idx = -1;
      d.forEach((v, i) => { if (weak[i] && (idx < 0 || v > d[idx])) idx = i; });
      sel = new Array(n).fill(false);
      sel[idx] = true;
    }
    if (rowQ !== undefined && rowQ < opt.rowQ) doubtful = true; // fila mal alineada o ilegible
    const value = sel.map((m, i) => (m ? LETTERS[i] : '')).join('');
    return {
      value, marks: sel, cancelled: canc.slice(), fills: row.map(v => Math.round(v * 1000) / 1000),
      sec: minSec ? minSec.map(v => Math.round(v * 100) / 100) : null, doubtful,
    };
  }

  /*
   * ¿Hay una X (o raya) que sobresale del círculo? Se mira la tinta en un anillo
   * justo por fuera de la burbuja (7,9-10,4 pt del centro), descartando la zona de
   * las burbujas vecinas, y se cuentan los "brazos" (grupos de sectores con tinta).
   * Una X da 4 brazos (se exigen al menos 3). Un relleno algo desbordado, 0-2.
   */
  // Devuelve el número de brazos: >= 3 es una X (anulada); 2 queda como dudosa.
  function crossedOut(D, row, o, S, inkT, dbg) {
    const [cx, cy] = row[o];
    const r0 = 7.9 * S, r1 = 10.4 * S, ex = 7.6 * S;
    const armT = 0.18; // los trazos finos de bolígrafo quedan más claros que un relleno
    const NS = 24;
    const cnt = new Array(NS).fill(0), ink = new Array(NS).fill(0);
    const ri = Math.ceil(r1);
    for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 < r0 * r0 || d2 > r1 * r1) continue;
      const x = cx + dx, y = cy + dy;
      let near = false;
      for (let k = 0; k < row.length; k++) {
        if (k === o) continue;
        const ux = x - row[k][0], uy = y - row[k][1];
        if (ux * ux + uy * uy < ex * ex) { near = true; break; }
      }
      if (near) continue;
      const a = Math.atan2(dy, dx);
      const sct = ((Math.floor((a + Math.PI) / (2 * Math.PI) * NS) % NS) + NS) % NS;
      cnt[sct]++;
      if (sample(D, x, y) > armT) ink[sct]++;
    }
    const on = cnt.map((c, i) => c >= 6 && ink[i] / c > 0.12);
    if (dbg) { dbg.cnt = cnt; dbg.ink = ink; dbg.on = on; }
    // grupos circulares de sectores consecutivos con tinta
    const clusters = [];
    const start = on.indexOf(false);
    if (start < 0) return 0; // todo el anillo con tinta: no es una X (p. ej. un círculo rodeando)
    let cur = null;
    for (let j = 1; j <= NS; j++) {
      const i = (start + j) % NS;
      if (on[i]) { if (!cur) { cur = []; clusters.push(cur); } cur.push(i); } else cur = null;
    }
    // los brazos son estrechos: se descartan grupos muy anchos (manchas grandes)
    const arms = clusters.filter(c => c.length <= 6);
    // una X deja 3-4 brazos; 2 brazos opuestos suelen ser un relleno que desborda por los lados
    return arms.length;
  }

  function readDni(cols, base, opt) {
    const digits = [];
    let doubtful = false;
    for (const col of cols) {
      const d = col.map(v => v - base);
      const marks = [];
      d.forEach((v, i) => { if (v >= opt.markT) marks.push(i); });
      if (d.some(v => v >= opt.weakT && v < opt.markT)) doubtful = true;
      if (marks.length === 1) digits.push(String(marks[0]));
      else if (marks.length === 0) {
        const mx = Math.max(...d);
        if (mx >= opt.weakT) { digits.push(String(d.indexOf(mx))); doubtful = true; } else digits.push('');
      } else { digits.push('?'); doubtful = true; }
    }
    // quitar columnas vacías al final; un hueco intermedio se muestra como '?'
    let last = -1;
    digits.forEach((x, i) => { if (x !== '') last = i; });
    const value = digits.slice(0, last + 1).map(x => (x === '' ? '?' : x)).join('');
    if (value.includes('?')) doubtful = true;
    return { value, digits, doubtful, fills: cols.map(c => c.map(v => Math.round(v * 1000) / 1000)) };
  }

  function warpDisplay(cv, img, H0, s) {
    const W = img.width, Hh = img.height;
    const srcM = cv.matFromImageData ? cv.matFromImageData(img) : (() => {
      const m = new cv.Mat(Hh, W, cv.CV_8UC4); m.data.set(img.data); return m;
    })();
    const toDisp = invertH(mulH(H0, [1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1]));
    const M = cv.matFromArray(3, 3, cv.CV_64F, toDisp);
    const dst = new cv.Mat();
    const w = Math.round(T.pageW * s), h = Math.round(T.pageH * s);
    cv.warpPerspective(srcM, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    const out = { data: new Uint8ClampedArray(dst.data), width: w, height: h };
    srcM.delete(); M.delete(); dst.delete();
    return out;
  }

  return { analyze, locate, T, bubblePt, dniPt, DEFAULTS, classify, LETTERS };
});
