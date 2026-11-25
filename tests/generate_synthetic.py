#!/usr/bin/env python3
"""Genera fotos sintéticas de la plantilla rellenada para probar el corrector.

Uso:  python3 tests/generate_synthetic.py plantilla.pdf SALIDA_DIR [N] [semilla]

Requiere: pymupdf, opencv-python-headless, numpy.
Crea SALIDA_DIR/sheet_XXX.jpg y SALIDA_DIR/sheet_XXX.json con la verdad.
"""
import json
import math
import os
import random
import sys

import cv2

HARD = os.environ.get("HARD") == "1"
import numpy as np
import pymupdf

# Geometría (puntos PDF) – idéntica a js/template.js
COL_X = [100.0, 222.32, 344.64, 466.96]
ROW_Y = [299.15, 325.44, 351.74, 378.03, 404.33, 430.62, 456.91, 483.21, 509.5, 535.8,
         562.09, 588.39, 614.68, 640.98, 667.27, 693.56, 719.86, 746.15, 772.45, 798.74]
OPT_DX = 16.0
DNI_X0, DNI_DX, DNI_Y0, DNI_DY = 449.78, 15.0, 66.0, 14.2


def bubble(q, o):
    c, r = divmod(q, 20)
    return COL_X[c] + o * OPT_DX, ROW_Y[r]


def draw_mark(img, x, y, s, kind, color, rng):
    """Dibuja una marca de bolígrafo centrada en (x,y) en píxeles; s = px por punto."""
    if kind in ("fill", "partial"):
        r = (5.4 if kind == "fill" else 3.6) * s * rng.uniform(0.9, 1.08)
        ox, oy = rng.uniform(-0.8, 0.8) * s, rng.uniform(-0.8, 0.8) * s
        # relleno a trazos (como un bolígrafo)
        n = int(r * 2.2)
        for i in range(n):
            t = -r + 2 * r * i / max(1, n - 1)
            half = math.sqrt(max(0.0, r * r - t * t)) * rng.uniform(0.85, 1.05)
            a = (int(x + ox - half), int(y + oy + t))
            b = (int(x + ox + half), int(y + oy + t + rng.uniform(-1, 1) * s))
            cv2.line(img, a, b, color, max(1, int(1.1 * s)), cv2.LINE_AA)
    elif kind == "cross":
        d = 4.5 * s
        th = max(1, int(0.9 * s))
        cv2.line(img, (int(x - d), int(y - d)), (int(x + d), int(y + d)), color, th, cv2.LINE_AA)
        cv2.line(img, (int(x - d), int(y + d)), (int(x + d), int(y - d)), color, th, cv2.LINE_AA)


def render_sheet(pdf, rng, dpi):
    page = pymupdf.open(pdf)[0]
    pix = page.get_pixmap(dpi=dpi)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3].copy()
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    s = dpi / 72.0
    ink = rng.choice([(140, 40, 20), (30, 30, 30), (160, 70, 30), (60, 20, 10)])  # BGR: azul/negro
    if HARD and rng.random() < 0.4:
        ink = (205, 150, 110)  # azul claro, poco contraste
    truth = []
    for q in range(80):
        u = rng.random()
        if u < 0.10:
            marks = []
        elif u < 0.13:
            marks = sorted(rng.sample(range(4), 2))
        else:
            marks = [rng.randrange(4)]
        kinds = []
        for o in marks:
            kind = "fill" if rng.random() < 0.85 else "partial"
            kinds.append(kind)
            x, y = bubble(q, o)
            draw_mark(img, x * s, y * s, s, kind, ink, rng)
        truth.append("".join("ABCD"[o] for o in marks))
        if HARD and not marks and rng.random() < 0.5:
            # cruz ("así no marque"): debe salir como dudosa
            o = rng.randrange(4)
            x, y = bubble(q, o)
            draw_mark(img, x * s, y * s, s, "cross", ink, rng)
            truth[-1] = "x" + "ABCD"[o]
    dni = "".join(str(rng.randrange(10)) for _ in range(8))
    if rng.random() < 0.25:
        dni = dni[:7]  # DNI de 7 cifras, última columna vacía
    for c, d in enumerate(dni):
        x, y = DNI_X0 + c * DNI_DX, DNI_Y0 + int(d) * DNI_DY
        cv2.circle(img, (int(x * s), int(y * s)), int(4.2 * s), ink, -1, cv2.LINE_AA)
    # algo de escritura a mano en la cabecera
    cv2.putText(img, "Juan Perez", (int(80 * s), int(103 * s)), cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, 0.5 * s / 2, ink, 1, cv2.LINE_AA)
    return img, truth, dni


def photo(sheet, rng, out_w, out_h):
    h, w = sheet.shape[:2]
    # curvatura suave del papel
    if rng.random() < 0.6:
        amp = rng.uniform(2, 9)
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        mapx = xx + amp * np.sin(yy / h * math.pi * rng.uniform(0.8, 1.6))
        mapy = yy + amp * np.sin(xx / w * math.pi * rng.uniform(0.8, 1.6))
        sheet = cv2.remap(sheet, mapx, mapy, cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    # fondo
    base = np.array(rng.choice([(40, 50, 70), (90, 110, 140), (200, 200, 205), (120, 120, 120), (30, 30, 30)]), np.float32)
    bg = np.ones((out_h, out_w, 3), np.float32) * base
    noise = cv2.GaussianBlur(np.random.default_rng(rng.randrange(1 << 30)).normal(0, 25, (out_h, out_w, 1)).astype(np.float32), (0, 0), 6)
    bg += noise.reshape(out_h, out_w, 1)
    # perspectiva
    scale = rng.uniform(0.62, 0.9) * min(out_w / w, out_h / h)
    if HARD and rng.random() < 0.4:
        scale *= rng.uniform(1.1, 1.3)  # foto cerrada: los bordes del papel se salen
    cw, ch = w * scale, h * scale
    cx, cy = out_w / 2 + rng.uniform(-0.05, 0.05) * out_w, out_h / 2 + rng.uniform(-0.05, 0.05) * out_h
    ang = math.radians(rng.uniform(-12, 12) + (180 if rng.random() < 0.1 else 0))
    pts = []
    for (dx, dy) in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
        x, y = dx * cw / 2, dy * ch / 2
        x, y = x * math.cos(ang) - y * math.sin(ang), x * math.sin(ang) + y * math.cos(ang)
        pts.append((cx + x + rng.uniform(-0.06, 0.06) * cw, cy + y + rng.uniform(-0.05, 0.05) * ch))
    # efecto de inclinación (la parte de arriba más pequeña)
    k = rng.uniform(0, 0.25 if HARD else 0.12)
    pts[0] = (pts[0][0] + k * cw / 2, pts[0][1])
    pts[1] = (pts[1][0] - k * cw / 2, pts[1][1])
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    M = cv2.getPerspectiveTransform(src, np.float32(pts))
    warped = cv2.warpPerspective(sheet.astype(np.float32), M, (out_w, out_h), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))
    mask = cv2.warpPerspective(np.ones((h, w), np.float32), M, (out_w, out_h))[:, :, None]
    img = bg * (1 - mask) + warped * mask
    # iluminación: gradiente + sombra
    yy, xx = np.mgrid[0:out_h, 0:out_w].astype(np.float32)
    g = 0.75 + 0.3 * (xx / out_w * rng.uniform(-1, 1) + yy / out_h * rng.uniform(-1, 1))
    if rng.random() < 0.5:
        sx, sy, sr = rng.uniform(0, out_w), rng.uniform(0, out_h), rng.uniform(0.2, 0.5) * out_w
        g *= 1 - rng.uniform(0.2, 0.45) * np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * sr * sr))
    tint = np.array([rng.uniform(0.85, 1.0), rng.uniform(0.9, 1.0), rng.uniform(0.9, 1.05)], np.float32)
    img = img * g[:, :, None] * tint
    img = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.4, 1.4))
    img += np.random.default_rng(rng.randrange(1 << 30)).normal(0, rng.uniform(2, 7), img.shape)
    return np.clip(img, 0, 255).astype(np.uint8)


def main():
    pdf, out = sys.argv[1], sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    os.makedirs(out, exist_ok=True)
    for i in range(n):
        rng = random.Random(seed * 1000 + i)
        sheet, truth, dni = render_sheet(pdf, rng, rng.choice([150, 200]))
        portrait = rng.random() < 0.85
        ow, oh = (1500, 2000) if portrait else (2000, 1500)
        img = photo(sheet, rng, ow, oh)
        name = f"sheet_{i:03d}"
        cv2.imwrite(os.path.join(out, name + ".jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, rng.randrange(65, 92)])
        with open(os.path.join(out, name + ".json"), "w") as f:
            json.dump({"answers": truth, "dni": dni}, f)
    print("ok", n)


if __name__ == "__main__":
    main()
