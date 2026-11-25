// Ejecuta el motor OMR sobre las imágenes sintéticas y compara con la verdad.
// Uso: NODE_PATH=<dir con pngjs/jpeg-js> node tests/run_node.js DIR [--verbose]
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const dir = process.argv[2];
const verbose = process.argv.includes('--verbose');
const cvPromise = new Promise((resolve) => {
  const cvm = require('../vendor/opencv.js');
  // el módulo de Emscripten es un "thenable" que se resuelve consigo mismo:
  // quitamos .then para no entrar en un bucle al resolver la promesa.
  if (cvm.Mat) { delete cvm.then; resolve(cvm); }
  else cvm.then((c) => { delete c.then; resolve(c); });
});
const OMR = require('../js/omr.js');

(async () => {
  const cv = await cvPromise;
  const files = fs.readdirSync(dir).filter(f => /\.(jpe?g)$/i.test(f)).sort();
  let silent = 0;
  const crossFills = [], crossSec = [], markSec = [];
  let crossMissed = 0, tot = 0, wrongQ = 0, failed = 0, dniOk = 0, dniN = 0, doubt = 0;
  const allBlankFills = [], allMarkFills = [];
  for (const f of files) {
    const truth = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.\w+$/, '.json'))));
    const raw = jpeg.decode(fs.readFileSync(path.join(dir, f)), { useTArray: true, formatAsRGBA: true });
    const res = OMR.analyze(cv, { data: raw.data, width: raw.width, height: raw.height }, { display: false });
    if (!res.ok) { failed++; console.log(f, 'FALLO', JSON.stringify(res.debug)); continue; }
    let bad = [];
    res.answers.forEach((a, i) => {
      tot++;
      if (a.doubtful) doubt++;
      const t = truth.answers[i];
      if (t.startsWith('x')) { // cruz: aceptable si se marca como dudosa
        crossFills.push(a.fills['ABCDE'.indexOf(t[1])] - res.debug.base); crossSec.push([a.fills['ABCDE'.indexOf(t[1])] - res.debug.base, a.sec['ABCDE'.indexOf(t[1])]]);
        if (!a.doubtful && a.value !== '') { wrongQ++; bad.push(`${i + 1}:cruz${t[1]}->${a.value} sin duda`); }
        else if (!a.doubtful) crossMissed++;
        return;
      }
      if (a.value !== truth.answers[i] && !a.doubtful) silent++;
      if (a.value !== truth.answers[i]) { wrongQ++; bad.push(`${i + 1}:${truth.answers[i] || '-'}->${a.value || '-'} [${a.fills.join(',')}]`); }
      a.fills.forEach((v, o) => { (truth.answers[i].includes('ABCDE'[o]) ? allMarkFills : allBlankFills).push(v - res.debug.base); if (truth.answers[i].includes('ABCDE'[o])) markSec.push([v - res.debug.base, a.sec[o]]); });
    });
    dniN++;
    if (res.dni.value === truth.dni) dniOk++;
    console.log(f, `score=${res.debug.score.toFixed(3)} q=${res.quality.toFixed(3)} base=${res.debug.base.toFixed(3)} ms=${res.debug.ms}`,
      bad.length ? `ERRORES ${bad.length}: ${bad.slice(0, 6).join(' ')}` : 'OK',
      res.dni.value === truth.dni ? 'dni OK' : `DNI ${truth.dni} -> ${res.dni.value} ${verbose ? JSON.stringify(res.dni.fills) : ''}`);
  }
  allBlankFills.sort((a, b) => b - a); allMarkFills.sort((a, b) => a - b);
  console.log('cruces no señaladas:', crossMissed, 'rellenos de cruces:', crossFills.sort((a, b) => a - b).map(v => v.toFixed(2)).join(' '));
  console.log(`\nHojas: ${files.length}, fallos de detección: ${failed}, preguntas mal: ${wrongQ}/${tot} (sin señalar como dudosas: ${silent}), dudosas: ${doubt}, DNI ok: ${dniOk}/${dniN}`);
  console.log('max vacías:', allBlankFills.slice(0, 5).map(v => v.toFixed(3)).join(' '), ' min marcadas:', allMarkFills.slice(0, 5).map(v => v.toFixed(3)).join(' '));
  if (process.env.SECSTATS) {
    const f = (arr) => arr.filter(([v]) => v >= 0.3).map(([, s]) => s).sort((a, b) => a - b);
    console.log('sec cruces (relleno>=0.3):', f(crossSec).join(' '));
    console.log('sec marcas (10 menores):', f(markSec).slice(0, 15).join(' '), ' n=', markSec.length);
    console.log('marcas con relleno<0.55: sec', markSec.filter(([v]) => v < 0.55).map(([v, s]) => v.toFixed(2) + '/' + s).join(' '));
  }
  process.exit(0);
})();
