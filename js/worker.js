/* Web Worker: carga OpenCV.js y ejecuta el reconocimiento sin bloquear la interfaz. */
/* global cv, OMR */
'use strict';

let ready = false;
const queue = [];

self.Module = undefined;
importScripts('../vendor/opencv.js', 'omr.js');

function onReady() {
  if (ready) return;
  ready = true;
  self.postMessage({ type: 'ready' });
  while (queue.length) handle(queue.shift());
}

// El módulo de Emscripten puede estar ya listo o ser un "thenable".
(function waitCv() {
  let c = self.cv;
  if (!c) { setTimeout(waitCv, 50); return; }
  if (c.Mat) { self.cv = c; onReady(); return; }
  if (typeof c.then === 'function') {
    c.then((m) => {
      if (m && m.then) delete m.then; // evita recursión de thenables
      self.cv = m;
      onReady();
    });
  } else {
    c.onRuntimeInitialized = () => onReady();
  }
})();

function handle(msg) {
  const { id, type } = msg;
  try {
    if (type === 'analyze') {
      const img = { data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height };
      const res = OMR.analyze(self.cv, img, msg.options || {});
      const transfer = [];
      if (res.display) transfer.push(res.display.data.buffer);
      self.postMessage({ type: 'result', id, result: res }, transfer);
    } else if (type === 'locate') {
      const img = { data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height };
      const res = OMR.locate(self.cv, img, msg.options || {});
      self.postMessage({ type: 'result', id, result: res });
    }
  } catch (e) {
    self.postMessage({ type: 'result', id, result: { ok: false, found: false, error: 'Error interno: ' + (e && e.message ? e.message : String(e)) } });
  }
}

self.onmessage = (ev) => {
  if (!ready) queue.push(ev.data);
  else handle(ev.data);
};
