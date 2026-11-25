# Corrector de exámenes

Aplicación web para **corregir automáticamente exámenes tipo test** (80 preguntas, opciones A–D) escaneando la hoja de respuestas con la cámara del móvil.

👉 **Úsala aquí:** https://aasalobrena.github.io/test-checker/

## Qué hace

- **Solucionarios**: escribe las respuestas correctas (`ABCD…`, también vale pegar `1A 2C 3B…`), tócalas en una cuadrícula o **escanea una hoja rellenada con las soluciones**. Número de preguntas configurable (1–80) y preguntas **anuladas** (`X` o `-`). Puedes guardar varios solucionarios y **pasarlos del ordenador al móvil con un código QR** (botón *Pasar al móvil*).
- **Corrección**: escanea con la cámara (la lectura es automática al encuadrar la hoja) o sube una foto. Muestra aciertos, fallos, en blanco y la puntuación:

  **Puntos = aciertos − 0,33 × fallos**, sobre el número de preguntas (sin contar las anuladas).
  - Más de una casilla marcada en una pregunta = **fallo**.
  - Por defecto la puntuación mínima es 0 (se puede permitir negativa en *Ayuda*).
- **Revisión**: imagen de la hoja con aciertos (verde), fallos (rojo), respuesta correcta (anillo azul) y marcas **dudosas** (naranja). Tocando una burbuja se corrige la lectura.
- **D.N.I.**: se lee de la hoja (editable).
- **Historial** con estadísticas y exportación a **CSV** (Excel, separador `;`).
- Los solucionarios y el historial se guardan en el navegador de cada dispositivo (`localStorage`); el enlace/QR de *Pasar al móvil* lleva el solucionario dentro del propio enlace.
- Funciona **sin conexión** tras la primera visita y se puede instalar como app. Todo se procesa en el dispositivo: no se sube ninguna imagen.

La plantilla de respuestas está en [`plantilla.pdf`](plantilla.pdf).

## Cómo funciona por dentro

`js/omr.js` usa [OpenCV.js](https://docs.opencv.org/) (incluido en `vendor/`) en un Web Worker:

1. Busca cuadriláteros (borde del papel o el recuadro «ZONA 2») y prueba cada uno en las 4 orientaciones, quedándose con el que hace coincidir las 320 burbujas.
2. Endereza la hoja, localiza cada fila de burbujas, ajusta una homografía robusta (RANSAC) y corrige pequeñas curvaturas.
3. Mide la tinta de cada burbuja (normalizando la iluminación) y su reparto por sectores para distinguir rellenos de cruces o rayas, que quedan como dudosas.
4. Si la alineación no es fiable, pide repetir la foto en lugar de dar un resultado erróneo.

## Pruebas

```bash
pip install pymupdf opencv-python-headless numpy
python3 tests/generate_synthetic.py plantilla.pdf /tmp/syn 50 1          # fotos sintéticas
HARD=1 python3 tests/generate_synthetic.py plantilla.pdf /tmp/hard 50 2  # casos difíciles
npm install --no-save jpeg-js
node tests/run_node.js /tmp/syn
```

## Desarrollo local

Es una web estática sin compilación:

```bash
python3 -m http.server 8000
```

La cámara en directo requiere HTTPS (o `localhost`).
