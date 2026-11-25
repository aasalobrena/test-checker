# Corrector de exámenes

Aplicación web para **corregir automáticamente exámenes tipo test** (80 preguntas, opciones A–E) escaneando la hoja de respuestas con la cámara del móvil.

👉 **Úsala aquí:** https://aasalobrena.github.io/test-checker/

## Qué hace

- **Solucionarios**: eliges el tipo de examen (**Teoría**, **Inglés** o **Aptitudes**) y la fecha; si un mismo día hay varios del mismo tipo se numeran solos (1, 2…). Escribe las respuestas correctas y la app cuenta cuántas preguntas son (`ABCD…`, también vale pegar `1A 2C 3B…`), tócalas en una cuadrícula o **escanea una hoja rellenada con las soluciones**. Hasta 80 preguntas y preguntas **anuladas** (`X` o `-`). Puedes guardar varios solucionarios y **pasarlos del ordenador al móvil con un código QR** (botón *Pasar al móvil*).
- **Opciones A–E** (también funciona con la plantilla de 4 opciones).
- **Corrección**: escanea con la cámara (la lectura es automática al encuadrar la hoja) o sube una foto. Muestra aciertos, fallos, en blanco y la puntuación:

  **Puntos = aciertos − 0,33 × fallos**, sobre el número de preguntas (sin contar las anuladas).
  - Más de una casilla marcada en una pregunta = **fallo**.
  - En **Aptitudes** se añade la nota normalizada **sobre 50**: puntos × 50 / nº de preguntas. Ejemplo de resumen: `49 12 13 45,04/74 30,43/50`.
  - Por defecto la puntuación mínima es 0 (se puede permitir negativa en *Ayuda*).
- **Revisión**: imagen de la hoja con aciertos (verde), fallos (rojo), respuesta correcta (anillo azul) y marcas **dudosas** (naranja). Tocando una burbuja se corrige la lectura.
- **D.N.I.**: se lee de la hoja (editable).
- **Historial** con estadísticas y exportación a **CSV** (Excel, separador `;`).
- **Sincronizar entre dispositivos** (botón *⇄ Sincronizar*): genera un enlace con solucionarios e historial (comprimidos en el `#` del enlace, que el navegador no envía a ningún servidor) y su QR. Al abrirlo en el otro dispositivo se fusionan los datos (altas, ediciones y borrados). Cada dispositivo guarda sus datos en el navegador (`localStorage`).
- Funciona **sin conexión** tras la primera visita y se puede instalar como app. Todo se procesa en el dispositivo: no se sube ninguna imagen.

Plantillas de respuestas: [`plantilla-5-opciones.pdf`](plantilla-5-opciones.pdf) (A–E) y [`plantilla.pdf`](plantilla.pdf) (A–D). La app lee las dos (la E está 16 pt a la derecha de la D).

**Anular una respuesta:** el alumno tacha la burbuja rellena con una **X que sobresalga del círculo**. Esa marca no cuenta (puede marcar otra opción). Si la X no se ve con claridad, la pregunta sale como dudosa para revisarla.

## Cómo funciona por dentro

`js/omr.js` usa [OpenCV.js](https://docs.opencv.org/) (incluido en `vendor/`) en un Web Worker:

1. Busca cuadriláteros (borde del papel o el recuadro «ZONA 2») y prueba cada uno en las 4 orientaciones, quedándose con el que hace coincidir las 320 burbujas.
2. Endereza la hoja, localiza cada fila de burbujas, ajusta una homografía robusta (RANSAC) y corrige pequeñas curvaturas.
3. Mide la tinta de cada burbuja (normalizando la iluminación) y su reparto por sectores para distinguir rellenos de cruces o rayas, que quedan como dudosas. Busca además «brazos» de tinta por fuera del círculo: una X que sobresale anula la respuesta.
4. Si la alineación no es fiable, pide repetir la foto en lugar de dar un resultado erróneo.

## Pruebas

```bash
pip install pymupdf opencv-python-headless numpy
python3 tests/generate_synthetic.py plantilla.pdf /tmp/syn 50 1          # fotos sintéticas
HARD=1 python3 tests/generate_synthetic.py plantilla.pdf /tmp/hard 50 2  # casos difíciles
OPTS=5 CANCEL=1 python3 tests/generate_synthetic.py plantilla-5-opciones.pdf /tmp/e5 40 3  # A-E y tachadas
npm install --no-save jpeg-js
node tests/run_node.js /tmp/syn
```

## Desarrollo local

Es una web estática sin compilación:

```bash
python3 -m http.server 8000
```

La cámara en directo requiere HTTPS (o `localhost`).
