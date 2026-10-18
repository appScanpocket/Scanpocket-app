// COPIE DU PILOTE 0.16 (Pilote_bonlivraison\preproc.js, 4660 octets), SANS CHANGEMENT. Utilisee par EnvDev\src\ecrans\bon_livraison.js.
// preproc.js - nettoyage d'image AVANT l'OCR, dans le navigateur (canvas), sans bibliotheque.
// Etapes : niveaux de gris, flou leger, seuil local, redressement (projection), suppression des lignes du tableau.
// Retourne { canvas, angle }.

function gris(cv) {
  const { width: w, height: h } = cv;
  const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
  return g;
}
function flou3(g, w, h) {
  const o = new Uint8Array(g.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h) { s += g[yy * w + xx]; n++; }
    }
    o[y * w + x] = s / n;
  }
  return o;
}
// seuil local (moyenne dans une fenetre via image integrale). Retourne 1 = encre.
function seuil(g, w, h, fen, k) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let ligne = 0;
    for (let x = 0; x < w; x++) { ligne += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + ligne; }
  }
  const b = new Uint8Array(w * h);
  const r = fen >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      const m = s / ((x1 - x0) * (y1 - y0));
      b[y * w + x] = g[y * w + x] < m * k && g[y * w + x] < 200 ? 1 : 0;
    }
  }
  return b;
}
function angleProjection(b, w, h) {
  const pts = [];
  const pas = Math.max(1, Math.round(w / 700));
  for (let y = 0; y < h; y += pas) for (let x = 0; x < w; x += pas) if (b[y * w + x]) pts.push(x, y);
  let best = 0, bs = -1;
  for (let a = -5; a <= 5.0001; a += 0.25) {
    const t = Math.tan((a * Math.PI) / 180);
    const hist = new Map();
    for (let i = 0; i < pts.length; i += 2) {
      const k = Math.round((pts[i + 1] - pts[i] * t) / pas);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    let s = 0;
    for (const v of hist.values()) s += v * v;
    if (s > bs * 1.0005 || (Math.abs(s - bs) <= bs * 0.0005 && Math.abs(a) < Math.abs(best))) { bs = Math.max(bs, s); best = a; }
  }
  return best;
}
function enleverLignes(b, w, h, runH, runV) {
  const del = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!b[y * w + x]) { x++; continue; }
      let x2 = x;
      while (x2 < w && b[y * w + x2]) x2++;
      if (x2 - x >= runH) for (let i = x; i < x2; i++) del[y * w + i] = 1;
      x = x2;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!b[y * w + x]) { y++; continue; }
      let y2 = y;
      while (y2 < h && b[y2 * w + x]) y2++;
      if (y2 - y >= runV) for (let i = y; i < y2; i++) del[i * w + x] = 1;
      y = y2;
    }
  }
  // on efface aussi 1 pixel autour des lignes pour ne pas laisser de bavures
  const out = new Uint8Array(b);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (del[y * w + x]) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h) out[yy * w + xx] = 0;
    }
  }
  return out;
}
function versCanvas(b, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const im = ctx.createImageData(w, h);
  for (let i = 0, j = 0; i < b.length; i++, j += 4) { const v = b[i] ? 0 : 255; im.data[j] = im.data[j + 1] = im.data[j + 2] = v; im.data[j + 3] = 255; }
  ctx.putImageData(im, 0, 0);
  return cv;
}

export function nettoyer(cv) {
  let w = cv.width, h = cv.height;
  let g = flou3(gris(cv), w, h);
  const fen = Math.max(15, Math.round(w / 40)) | 1;
  let b = seuil(g, w, h, fen, 0.85);
  const angle = angleProjection(b, w, h);
  let src = cv;
  if (Math.abs(angle) >= 0.25) {
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const ctx = c2.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((-angle * Math.PI) / 180);
    ctx.drawImage(cv, -w / 2, -h / 2);
    src = c2;
    g = flou3(gris(src), w, h);
    b = seuil(g, w, h, fen, 0.85);
  }
  b = enleverLignes(b, w, h, Math.round(w * 0.05), Math.round(w * 0.03));
  return { canvas: versCanvas(b, w, h), angle };
}
