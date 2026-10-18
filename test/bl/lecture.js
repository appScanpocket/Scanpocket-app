// lecture.js - logique PURE de la lecture des bons de livraison (aucun acces reseau, aucun DOM).
// Entree : des "boites de texte" {t, x0, y0, x1, y1} venant de pdf.js ou de Tesseract.js.
// Sortie : un tableau de lignes, une PROPOSITION d'articles, un controle arithmetique.
// Rien n'est stocke, rien n'est envoye. La sortie n'est qu'une proposition.
//
// COPIE DU PILOTE 0.16 (Pilote_bonlivraison\lecture.js, etat du 18/10 18:26, 28972 octets), ADAPTEE pour l'application. Changements :
//  1. stockDepuisArticles(articles) + indexerStock(items) : le stock vient des articles de l'application (plus d'un CSV) ; chargerStock(csv) reste, il appelle indexerStock ;
//     un article peut avoir plusieurs codes-barres (eans) ; champ fo (fournisseur) conserve pour l'affichage.
//  2. analyser() : garde-fou. t.verdict = 'tableau-introuvable' (en-tete ou lignes absents) ou 'trop-incertaine' (quantites illisibles sur au moins la moitie des lignes) ;
//     dans ces deux cas l'identification est VIDE (aucune valeur aberrante pre-remplie) et aucune ligne n'est proposee.
//  3. extraireIdentification() : un bloc d'adresse client / destinataire n'est jamais pris pour l'emetteur, y compris quand la ligne est une raison sociale ; lignes d'adresse postale ignorees.
//  4. voyant() : ecart arrondi au centime avant la comparaison (flottants).
//  5. emetteur de repli : au moins 3 lettres (comme le pilote 0.17).
//  6. vitesse sur un gros stock : proposer() garde les deux meilleurs scores en un passage (plus de tri complet de tout le stock a chaque ligne) et scoreNom() decoupe le texte de la ligne une seule fois
//     (mesure PC, 15 lignes : 50 000 articles 12 s -> 2,8 s ; 20 000 articles 1,6 s -> 1,2 s ; memes propositions) ; stock vide : plus de plantage (« non reconnu » sans piste).
//  (L'arrondi de controleArith et RE_ADRESSE_CLIENT venaient deja du pilote a cette date ; le pilote 0.17 y ajoute t.incertain = tout « non reconnu » : NON reprise ici,
//   car un BL lisible dont aucun article n'est dans le stock serait cache ; ici « trop incertaine » = quantites illisibles sur au moins la moitie des lignes.)

// A incrementer a chaque modification de CETTE copie
export const VERSION_LECTURE = '0.16-appli.1 - 18/10';

// ---------- utilitaires texte ----------
export const strip = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const norm = (s) => strip(s).replace(/[^a-z0-9]/g, '');
export const toks = (s) => strip(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

export function lev(a, b, max = 99) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let mn = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < mn) mn = v;
    }
    if (mn > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// ---------- CSV du stock ----------
export function parseCsv(text) {
  const t = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ';') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export function chargerStock(csvText) {
  const rows = parseCsv(csvText);
  rows.shift(); // en-tete
  const liste = [];
  for (const r of rows) {
    if (r.length < 3 || !r[0]) continue;
    liste.push({ ref: r[0].trim(), ean: (r[1] || '').trim(), nom: r[2].trim(), emp: r[3] || '', qte: r[4] || '' });
  }
  return indexerStock(liste);
}

// Stock de l'application : articles = [{ ref, ean, eans, nom, emp, fo }] (voir blStockDepuisArticles dans l'application).
export function stockDepuisArticles(articles) {
  return indexerStock((articles || []).map((a) => ({ ref: String(a.ref || '').trim(), ean: String(a.ean || '').trim(), eans: a.eans || null, nom: String(a.nom || '').trim(), emp: a.emp || '', qte: a.qte || '', fo: a.fo || '' })));
}

// Construit les index de recherche (reference, code-barres, nom, codes du nom) a partir d'articles { ref, ean, nom, ... }.
export function indexerStock(liste) {
  const items = [];
  const byRef = new Map(), byEan = new Map(), strong = new Map(), codes = new Map();
  const add = (m, k, it) => { if (!k) return; const a = m.get(k) || []; if (!a.includes(it)) a.push(it); m.set(k, a); };
  for (const base of liste) {
    if (!base.ref || !base.nom) continue;
    const it = base;
    it.tokens = toks(it.nom);
    const parts = it.nom.split(' - ');
    it.brand = parts.length > 1 ? norm(parts[parts.length - 1]) : '';
    it.codes = it.tokens.filter((x) => /\d/.test(x) && x.length >= 3);
    items.push(it);
    byRef.set(it.ref.toLowerCase(), [it]);
    for (const e of new Set([it.ean].concat(it.eans || []))) if (e) add(byEan, e, it);
    add(strong, norm(it.nom), it);
    for (const c of it.codes) {
      add(codes, c, it);
      if (it.brand) { add(strong, it.brand + c, it); add(strong, c + it.brand, it); }
    }
  }
  return { items, byRef, byEan, strong, codes };
}

// ---------- nombres ----------
// Accepte 3,10  1 234,56  1.234,56  1,234.56  12  5 %  (retourne null si illisible)
export function num(s) {
  if (s == null) return null;
  let t = String(s).replace(/[\u00a0\u202f\s]/g, '').replace(/(eur|euros?|\u20ac)$/i, '').replace(/%$/, '');
  if (!/^-?[\d.,]+$/.test(t) || !/\d/.test(t)) return null;
  const hasC = t.includes(','), hasP = t.includes('.');
  if (hasC && hasP) {
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
  } else if (hasC) {
    t = (t.match(/,/g) || []).length > 1 ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if (hasP) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  }
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}
// corrige les confusions OCR dans une cellule qui doit etre un nombre
export function fixNum(s) {
  const t = String(s).trim();
  if (/^[0-9OolI|S.,\s%x\u00d7-]+$/.test(t) && /[0-9]/.test(t)) return t.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/S/g, '5');
  return t;
}
export function qtyNum(s) {
  if (s == null) return null;
  const t = fixNum(s).replace(/\s+/g, ' ').trim();
  const m = t.match(/^(\d+)\s*[x\u00d7*]\s*(\d+(?:[.,]\d+)?)$/i); // 1 x 12
  if (m) return num(m[1]) * num(m[2]);
  return num(t);
}

// ---------- boites -> lignes -> cellules ----------
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function estimerAngle(items) {
  if (items.length < 6) return 0;
  const H = median(items.map((i) => i.y1 - i.y0)) || 10;
  let best = 0, bestS = -1;
  for (let a = -10; a <= 10.0001; a += 0.25) { // copie appli : -10 a +10 degres (pilote : -5 a +5)
    const k = Math.tan((a * Math.PI) / 180);
    const bins = new Map();
    for (const i of items) {
      const cy = (i.y0 + i.y1) / 2 - ((i.x0 + i.x1) / 2) * k;
      const b = Math.round(cy / (H * 0.5));
      bins.set(b, (bins.get(b) || 0) + 1);
    }
    let s = 0;
    for (const v of bins.values()) s += v * v;
    if (s > bestS + 1e-9 || (Math.abs(s - bestS) < 1e-9 && Math.abs(a) < Math.abs(best))) { bestS = s; best = a; }
  }
  return best;
}

export function grouperLignes(itemsIn) {
  // on retire les boites sans lettre ni chiffre (restes de bordures) et les mots de tres faible confiance OCR sans chiffre
  const items = itemsIn.filter((i) => i.t && /[A-Za-z0-9\u00c0-\u00ff]/.test(i.t) && !(i.conf != null && i.conf < 35 && !/\d/.test(i.t)));
  if (!items.length) return { lignes: [], angle: 0, H: 10 };
  const angle = estimerAngle(items);
  const k = Math.tan((angle * Math.PI) / 180);
  const H = median(items.map((i) => i.y1 - i.y0)) || 10;
  const withY = items.map((i) => ({ ...i, cy: (i.y0 + i.y1) / 2 - ((i.x0 + i.x1) / 2) * k }));
  withY.sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const it of withY) {
    const L = lines[lines.length - 1];
    if (L && it.cy - L.cy < H * 0.6) { L.items.push(it); L.cy = L.items.reduce((s, x) => s + x.cy, 0) / L.items.length; }
    else lines.push({ items: [it], cy: it.cy });
  }
  const lignes = lines.map((L) => {
    L.items.sort((a, b) => a.x0 - b.x0);
    const cells = [];
    for (const it of L.items) {
      const c = cells[cells.length - 1];
      if (c && it.x0 - c.x1 < H * 0.65) { c.t += ' ' + it.t.trim(); c.x1 = Math.max(c.x1, it.x1); c.y1 = Math.max(c.y1, it.y1); }
      else cells.push({ t: it.t.trim(), x0: it.x0, x1: it.x1, y0: it.y0, y1: it.y1 });
    }
    for (const c of cells) c.cx = (c.x0 + c.x1) / 2;
    return { cy: L.cy, cells, texte: cells.map((c) => c.t).join(' ') };
  });
  return { lignes, angle, H };
}

// ---------- en-tete de tableau ----------
function typeEntete(t) {
  const n = norm(t);
  if (!n) return null;
  if (/^(pos|poste|n$|no$)/.test(n)) return 'pos';
  if (/^(prix|pu|puht|unitaire)/.test(n)) return 'pu';
  if (/^(remise|rem|rabais|escompte)/.test(n) || n === '') return 'remise';
  if (/^(unite|un$|u$)/.test(n)) return 'unite';
  if (/^(design|descr|libell|produit|intitul)/.test(n)) return 'desig';
  if (/command/.test(n)) return 'cmd'; // quantite commandee : jamais utilisee comme quantite recue
  if (/reliq|restant|solde/.test(n)) return 'reliq';
  if (/livr/.test(n) || /^(qt|quant|nb|nombre|recu)/.test(n)) return 'qty';
  if (/^(total|montant|net|valeur|ht$)/.test(n)) return 'montant';
  if (/re+f/.test(n) || /^(art|code|ean|gtin|cb)/.test(n)) return 'ref';
  return null;
}

// --- en-tete TOLERANT (copie appli, pour les photos d'ecran / de papier : OCR bruite) ---
// mots d'en-tete avec une faute d'OCR (distance d'edition 1, 2 pour les mots de 9 lettres et plus ; mots de moins de 5 lettres : exacts seulement)
const MOTS_ENTETE = [['cmd', 'commandee'], ['cmd', 'commande'], ['reliq', 'reliquat'], ['desig', 'designation'], ['desig', 'description'], ['desig', 'libelle'], ['desig', 'produit'], ['desig', 'intitule'],
  ['qty', 'quantite'], ['qty', 'livree'], ['qty', 'livre'], ['ref', 'reference'], ['pu', 'unitaire'], ['montant', 'montant']];
function typeEnteteFlou(t) {
  const ty = typeEntete(t);
  if (ty) return { type: ty, flou: false };
  for (const tk of toks(t)) {
    if (tk.length < 5) continue;
    for (const [type, mot] of MOTS_ENTETE) {
      const d = mot.length >= 9 ? 2 : 1;
      if (Math.abs(tk.length - mot.length) <= d && lev(tk, mot, d) <= d) return { type, flou: true };
    }
  }
  return null;
}
function colonnesDe(cells, flou) {
  const cols = [];
  for (const c of cells) {
    const r = flou ? typeEnteteFlou(c.t) : (typeEntete(c.t) ? { type: typeEntete(c.t), flou: false } : null);
    if (r && !cols.some((x) => x.type === r.type)) cols.push({ type: r.type, x0: c.x0, x1: c.x1, cx: c.cx, texte: c.t, flou: r.flou });
  }
  return cols;
}
const aType = (cols, t) => cols.some((c) => c.type === t);
const RE_FIN_TABLEAU = /\b(sous.?total|total|tva|a payer|net a payer|suite page|montant ht|montant tva)\b/;
const estNombreSimple = (t) => { const x = fixNum(t).replace(/\s+/g, ''); return /^\d{1,5}([.,]\d{1,3})?$/.test(x); };
// lignes de corps de tableau apres la ligne i : au moins un nombre simple ET un texte (3 lettres ou une reference de 8 chiffres) ; s'arrete au pied (total, TVA...)
function corpsDe(lignes, i) {
  const out = [];
  for (let k = i + 1; k < lignes.length && out.length < 14; k++) {
    const L = lignes[k], sn = strip(L.texte).replace(/[^a-z0-9 %]/g, ' ').replace(/\s+/g, ' ').trim();
    if (RE_FIN_TABLEAU.test(sn)) break;
    const nombres = L.cells.filter((c) => estNombreSimple(c.t)), texte = L.cells.some((c) => /[A-Za-zÀ-ÿ]{3}/.test(c.t) || /\d{8,}/.test(c.t.replace(/\s/g, '')));
    if (nombres.length && texte) out.push({ ligne: L, nombres });
  }
  return out;
}
// colonne des quantites deduite de la position des nombres entiers du corps : le groupe le plus a droite (et a gauche des colonnes de prix connues) present sur la plupart des lignes
function deduireQty(corps, cols, H) {
  const groupes = [];
  for (const d of corps) for (const c of d.nombres) {
    if (/[.,]/.test(c.t)) continue; // les prix ont des decimales
    let g = groupes.find((x) => Math.abs(x.cx - c.cx) < H * 2.5);
    if (!g) { g = { cx: c.cx, cells: [], lignes: new Set() }; groupes.push(g); }
    g.cells.push(c); g.lignes.add(d.ligne); g.cx = g.cells.reduce((s, x) => s + x.cx, 0) / g.cells.length;
  }
  const besoin = Math.max(2, Math.ceil(corps.length * 0.6));
  const xPrix = Math.min(...cols.filter((c) => ['pu', 'montant', 'remise'].includes(c.type)).map((c) => c.x0), Infinity);
  const ok = groupes.filter((g) => g.lignes.size >= besoin && g.cx < xPrix).sort((a, b) => b.cx - a.cx);
  if (!ok.length) return null;
  const g = ok[0];
  return { type: 'qty', x0: Math.min(...g.cells.map((c) => c.x0)), x1: Math.max(...g.cells.map((c) => c.x1)), cx: g.cx, texte: '(deduite)', flou: true, deduite: true };
}
function trouverEntete(lignes, H) {
  // 1. d'origine : une ligne, mots d'en-tete exacts, designation + quantite
  for (let i = 0; i < lignes.length; i++) {
    const cols = colonnesDe(lignes[i].cells, false);
    if (cols.length >= 2 && aType(cols, 'desig') && aType(cols, 'qty')) return { index: i, cols, mode: 'exact' };
  }
  // 2. une ligne, mots d'en-tete avec une faute d'OCR
  for (let i = 0; i < lignes.length; i++) {
    const cols = colonnesDe(lignes[i].cells, true);
    if (cols.length >= 2 && aType(cols, 'desig') && aType(cols, 'qty')) return { index: i, cols, mode: 'tolerant' };
  }
  // 3. en-tete sur DEUX lignes de texte consecutives (mot coupe, retour a la ligne dans la cellule, OCR qui separe les lignes)
  for (let i = 0; i + 1 < lignes.length; i++) {
    if (lignes[i + 1].cy - lignes[i].cy > H * 3.5) continue;
    const a = colonnesDe(lignes[i].cells, true), b = colonnesDe(lignes[i + 1].cells, true);
    if (!a.length || !b.length) continue;
    const cols = a.concat(b.filter((c) => !aType(a, c.type)));
    if (aType(cols, 'desig') && aType(cols, 'qty')) return { index: i + 1, cols, mode: 'deux-lignes', texte: lignes[i].texte + ' / ' + lignes[i + 1].texte };
  }
  // 4. en-tete incomplet mais corps de tableau reconnaissable : colonnes manquantes deduites des positions (seulement si peu risque : pas de colonne « commande » ambigue)
  for (let i = 0; i < lignes.length; i++) {
    const cols = colonnesDe(lignes[i].cells, true);
    if (!cols.length || aType(cols, 'cmd')) continue;
    const corps = corpsDe(lignes, i);
    if (corps.length < 2 || !(cols.length >= 2 || aType(cols, 'ref') || aType(cols, 'desig'))) continue;
    const tous = cols.slice();
    if (!aType(tous, 'qty')) { const q = deduireQty(corps, tous, H); if (!q) continue; tous.push(q); }
    if (!aType(tous, 'desig')) {
      const qty = tous.find((c) => c.type === 'qty'), ref = tous.find((c) => c.type === 'ref');
      const finRef = ref ? Math.max(ref.x1, ...corps.map((d) => d.ligne.cells[0]).filter((c) => c && c.x1 < qty.x0 && /\d/.test(c.t) && !/\s/.test(c.t)).map((c) => c.x1)) : Math.min(...corps.map((d) => d.ligne.cells[0].x0));
      if (!(qty.x0 > finRef)) continue;
      tous.push({ type: 'desig', x0: finRef + 1, x1: qty.x0 - 1, cx: (finRef + qty.x0) / 2, texte: '(deduite)', flou: true, deduite: true });
    }
    return { index: i, cols: tous, mode: 'deduit', texte: lignes[i].texte + ' (colonnes deduites des positions)' };
  }
  return null;
}
// meilleures lignes candidates pour l'en-tete (diagnostic) : lignes triees par nombre de types de colonnes reconnus
function candidatsEntete(lignes) {
  return lignes.map((l, index) => ({ index, texte: l.texte, cols: colonnesDe(l.cells, true) })).filter((x) => x.cols.length)
    .map((x) => ({ index: x.index, texte: x.texte, score: x.cols.reduce((s, c) => s + (c.flou ? 0.7 : 1), 0), types: x.cols.map((c) => c.type + (c.flou ? '~' : '')), corps: corpsDe(lignes, x.index).length }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 5);
}
const RE_IGNORE = /\b(frais|port|transport|livraison|remise|escompte|rabais|total|sous.?total|tva|emballage|acompte|taxe|eco.?participation|supplement|forfait)\b/;

function colonneProche(cell, cols) {
  let best = null, bd = 1e9;
  for (const c of cols) {
    const d = Math.min(Math.abs(cell.x0 - c.x0), Math.abs(cell.x1 - c.x1), Math.abs(cell.cx - c.cx));
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

const lastMoney = (txt) => {
  const m = txt.match(/\d[\d\s.]*[,.]\d{2}(?!\d)/g);
  if (m) return num(m[m.length - 1]);
  const m2 = txt.match(/\d+/g);
  return m2 ? num(m2[m2.length - 1]) : null;
};

// garde seulement les morceaux qui ressemblent a un nombre (retire les restes de bordures : | ! ; { } et lettres parasites)
function cleanNum(txt) {
  if (!txt) return '';
  return txt.split(/\s+/).map((w) => w.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z%]+$/g, '')).filter((w) => (/\d/.test(w) && /^[0-9OolI|S.,%x×-]+$/.test(w)) || /^[x×*]$/i.test(w)).join(' ');
}

export function lireTableau(itemsIn) {
  const { lignes, angle, H } = grouperLignes(itemsIn);
  const ent = trouverEntete(lignes, H);
  const res = { angle, H, nbLignes: lignes.length, nbBoites: itemsIn.length, texteLignes: lignes.map((l) => l.texte), diag: { candidats: candidatsEntete(lignes), mode: ent ? ent.mode : null }, entete: null, colonnes: [], rows: [], totaux: { ht: null, tva: null, tvaTaux: null, ttc: null, pieces: null }, prix: false };
  // nombre de lignes indique sur le document (en-tete ou pied) : « nb lignes 4 », « nombre d'articles : 4 »...
  res.totaux.nbLignes = null;
  for (const L of lignes) {
    const sn0 = strip(L.texte).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\btotal\b/.test(sn0)) continue;
    const m = /(?:^| )(?:nb ?(?:de )?lignes|nombre (?:de )?(?:lignes|articles)|nb ?articles|lignes|articles) (\d{1,4})$/.exec(sn0);
    if (m) { res.totaux.nbLignes = parseInt(m[1], 10); break; }
  }
  if (!ent) return res;
  res.entete = ent.texte || lignes[ent.index].texte;
  res.indexEntete = ent.index;
  res.colonnes = ent.cols.map((c) => c.type);
  res.prix = res.colonnes.includes('pu') || res.colonnes.includes('montant');
  let finTab = false, last = null, lastCy = null;
  for (let i = ent.index + 1; i < lignes.length; i++) {
    const L = lignes[i];
    const sn = strip(L.texte).replace(/[^a-z0-9 %]/g, ' ').replace(/\s+/g, ' ').trim();
    // totaux (toujours analyses apres l'en-tete)
    if (/(sous.?total|total ht|montant ht|total hors|\bht\b)/.test(sn)) res.totaux.ht = lastMoney(L.texte);
    else if (/\btva\b/.test(sn) && /%/.test(L.texte)) {
      const m = L.texte.match(/(\d+(?:[.,]\d+)?)\s*%/);
      if (m) res.totaux.tvaTaux = num(m[1]);
      res.totaux.tva = lastMoney(L.texte.slice(L.texte.indexOf('%') + 1));
    } else if (/(total ttc|a payer|\bttc\b)/.test(sn)) res.totaux.ttc = lastMoney(L.texte);
    if (/total (pieces|piece|articles|quantite|colis|unites)/.test(sn)) { const m = L.texte.match(/\d+/g); if (m) res.totaux.pieces = parseInt(m[m.length - 1], 10); }
    if (RE_FIN_TABLEAU.test(sn)) finTab = true;
    if (finTab) continue;
    // affectation des cellules aux colonnes
    const row = { ref: '', pos: '', desig: '', qtyTxt: '', unite: '', puTxt: '', remiseTxt: '', montantTxt: '', cmdTxt: '', reliqTxt: '', note: '', ligne: L.texte };
    const KEY = { ref: 'ref', pos: 'pos', desig: 'desig', qty: 'qtyTxt', unite: 'unite', pu: 'puTxt', remise: 'remiseTxt', montant: 'montantTxt', cmd: 'cmdTxt', reliq: 'reliqTxt' };
    for (const c of L.cells) {
      const col = colonneProche(c, ent.cols);
      if (!col) continue;
      const k = KEY[col.type];
      row[k] = row[k] ? row[k] + ' ' + c.t : c.t;
    }
    for (const k of ['qtyTxt', 'puTxt', 'remiseTxt', 'montantTxt']) row[k] = cleanNum(row[k]);
    row.ref = row.ref.trim();
    const nouvelleLigne = last == null || L.cy - lastCy >= H * 2.0; // une suite de designation est collee a la ligne du dessus
    const aDonnees = row.qtyTxt || row.montantTxt || row.puTxt || /\d{8,}/.test(row.ref.replace(/\s/g, ''))
      || (nouvelleLigne && !row.ref && row.desig && row.desig.split(/\s+/).length <= 8 && RE_IGNORE.test(strip(row.desig))); // ligne de transport sans chiffre : gardee pour etre montree comme ignoree
    if (!aDonnees) {
      // ligne de suite (designation sur plusieurs lignes) : rattachee a la ligne precedente, jamais comparee
      if (last && row.desig && L.cy - lastCy < H * 2.6) { last.note += (last.note ? ' / ' : '') + row.desig; lastCy = L.cy; }
      continue;
    }
    row.qty = qtyNum(row.qtyTxt);
    row.pu = num(fixNum(row.puTxt));
    row.remise = row.remiseTxt ? num(fixNum(row.remiseTxt)) : null;
    row.montant = num(fixNum(row.montantTxt));
    res.rows.push(row);
    last = row; lastCy = L.cy;
  }
  return res;
}

// ---------- correspondance avec le stock ----------
const wt = (t) => (/\d/.test(t) ? 3 : t.length <= 1 ? 0.3 : 1);
function tokEq(a, b) {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  const m = Math.min(a.length, b.length);
  if (m >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (m >= 5 && lev(a, b, 1) <= 1) return true;
  return false;
}

let memoTexte = null, memoL = null, memoPairs = null; // copie appli : le texte de la ligne est decoupe UNE fois (et non pour chaque article du stock)
export function scoreNom(texte, it) {
  if (texte !== memoTexte) {
    memoTexte = texte; memoL = toks(texte); memoPairs = [];
    for (let i = 0; i < memoL.length - 1; i++) if (/\d/.test(memoL[i] + memoL[i + 1]) && (memoL[i] + memoL[i + 1]).length <= 14) memoPairs.push({ i, p: memoL[i] + memoL[i + 1] });
  }
  const L = memoL, pairs = memoPairs;
  const S = it.tokens;
  if (!L.length || !S.length) return 0;
  const used = new Array(L.length).fill(false);
  let sMatched = 0, sTotal = 0;
  for (const s of S) {
    sTotal += wt(s);
    let j = L.findIndex((l) => tokEq(l, s));
    if (j >= 0) { used[j] = true; sMatched += wt(s); continue; }
    const pr = pairs.find((q) => q.p === s);
    if (pr) { used[pr.i] = true; used[pr.i + 1] = true; sMatched += wt(s); }
  }
  let lMatched = 0, lTotal = 0;
  L.forEach((l, i) => { lTotal += wt(l); if (used[i]) lMatched += wt(l); });
  const P = lMatched / lTotal, R = sMatched / sTotal;
  return P + R === 0 ? 0 : (200 * P * R) / (P + R);
}

export function chercherId(refTexte, stock) {
  const r0 = (refTexte || '').trim();
  if (!r0) return null;
  const direct = chercherId1(r0, stock);
  if (direct) return direct;
  // cellule avec des restes de bordure : on essaie chaque morceau (EAN ou reference exacte seulement)
  for (const w of r0.split(/\s+/)) {
    const c = w.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, '');
    if (c.length >= 4 && c !== r0) { const x = chercherId1(c, stock); if (x && (x.type === 'ean' || x.type === 'ref')) return x; }
  }
  return null;
}
function chercherId1(r, stock) {
  const d = r.replace(/[\s.-]/g, '');
  if (/^\d{8,14}$/.test(d)) {
    const e = stock.byEan.get(d);
    if (e) return { type: 'ean', items: e };
    const near = stock.items.filter((it) => it.ean && it.ean.length === d.length && lev(it.ean, d, 1) <= 1);
    if (near.length) return { type: 'ean~', items: near };
  }
  const x = stock.byRef.get(r.toLowerCase());
  if (x) return { type: 'ref', items: x };
  const n = norm(r);
  if (n) {
    const s = stock.strong.get(n);
    if (s) return { type: 'refnorm', items: s };
    const c = stock.codes.get(n);
    if (c) return { type: 'code', items: c };
  }
  return null;
}

export function classer(conf, margeOk, idType) {
  if (idType) return conf >= 90 ? 'reconnu' : conf >= 50 ? 'a verifier' : 'non reconnu';
  if (conf >= 92 && margeOk) return 'reconnu';
  if (conf >= 60) return 'a verifier';
  return 'non reconnu';
}

// Alias retenus (maquette) : correspondance {emetteur normalise + reference normalisee} -> article.
// Gardee EN MEMOIRE seulement (perdue au rechargement de la page) ; aucun stockage durable.
export const ALIAS = new Map();
const normAlias = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function cleAlias(emetteur, ref) {
  const r = normAlias(ref);
  return r ? normAlias(emetteur) + '|' + r : null;
}

// row : {ref, desig, qty}. Retourne la proposition (ou "non reconnu" avec une simple piste).
// Ordre : EAN exact, notre reference exacte, alias retenu, reference normalisee, nom approchant.
export function proposer(row, stock, emetteur) {
  const texte = row.desig || '';
  const refTxt = row.ref || '';
  const texteTout = (refTxt + ' ' + texte).trim();
  // 1) par identifiant
  const id = chercherId(refTxt, stock);
  // les deux meilleurs scores en UN passage (copie appli : plus de tri complet du stock a chaque ligne) ; a score egal, l'article le plus haut dans le stock passe devant, comme le tri stable d'origine
  let top = null, second = null;
  for (const it of stock.items) {
    const s = scoreNom(texteTout, it);
    if (!top || s > top.s) { second = top; top = { it, s }; } else if (!second || s > second.s) second = { it, s };
  }
  if (!top) top = { it: null, s: 0 }; // stock vide : rien a proposer (le pilote plantait ici)
  let out;
  const cleA = cleAlias(emetteur, refTxt);
  const alias = cleA && !(id && (id.type === 'ean' || id.type === 'ref')) ? ALIAS.get(cleA) : null;
  if (alias) {
    out = { item: alias.item, conf: 100, via: 'alias', nomScore: null, raison: 'alias retenu (fournisseur)', classe: 'reconnu' };
  } else if (id && id.items.length === 1 && id.type !== 'code' && id.type !== 'ean~') {
    const it = id.items[0];
    const ns = texte ? scoreNom(texte, it) : null;
    const accord = ns === null || ns >= 40;
    const conf = accord ? (id.type === 'refnorm' ? 95 : 100) : 55;
    out = { item: it, conf, via: id.type, nomScore: ns, raison: accord ? 'identifiant ' + id.type : 'identifiant ' + id.type + ' mais designation differente (' + Math.round(ns) + ')' };
    out.classe = classer(conf, true, true);
  } else if (id && id.items.length >= 1) {
    const cand = id.items.map((it) => ({ it, s: scoreNom(texteTout, it) })).sort((a, b) => b.s - a.s)[0];
    const conf = Math.min(id.type === 'ean~' ? 70 : 80, Math.max(cand.s, 0) + (id.type === 'ean~' ? 20 : 0));
    out = { item: cand.it, conf: Math.round(conf), via: id.type + (id.items.length > 1 ? ' (ambigu)' : ''), nomScore: cand.s, raison: 'identifiant approximatif ou ambigu : ' + id.type };
    out.classe = conf >= 50 ? 'a verifier' : 'non reconnu';
  } else {
    const marge = top.s - (second ? second.s : 0);
    out = { item: top.s >= 60 ? top.it : null, piste: top.it, conf: Math.round(top.s), via: 'nom', nomScore: top.s, marge: Math.round(marge), raison: 'nom approchant (marge ' + Math.round(marge) + ')' };
    out.classe = classer(top.s, marge >= 10, false);
  }
  if (out.classe !== 'non reconnu' && (row.qty == null || row.qty <= 0)) {
    if (out.classe === 'reconnu') out.classe = 'a verifier';
    out.raison += ' ; quantite illisible';
  }
  if (out.classe === 'non reconnu') { out.piste = out.piste || out.item || top.it; out.item = null; }
  out.conf = Math.round(out.conf);
  return out;
}

// ---------- identification (en-tete du document, au-dessus du tableau) ----------
// Rien n'est invente : champ non trouve = null. Les valeurs sont gardees telles que lues (aucune correction).
const RE_NUM_TOKEN = '([A-Za-z0-9][A-Za-z0-9/.\\-]*)';
const RE_SOCIETE = /\b(SA|SPRL|SRL|NV|BV|BVBA|SARL|SAS|GmbH|Ltd)\b/;
const RE_TITRE = /bon\s+de\s+livraison|delivery\s+note|lieferschein|\bpage\b|^\s*date\b|\bdate\s+de\b/i;
// mots de titre de document : jamais un emetteur
const RE_MOT_TITRE = /^\s*(?:facture|bon\s+de\s+livraison|devis|commande|avoir|page|date|total)\b/i;
// bloc d'adresse client / destinataire : jamais pris comme emetteur
const RE_ADRESSE_CLIENT = /\b(?:affaire|ne\s+pas\s+rattacher|destinataire|livr[ée]\s+[àa]|adresse\s+de\s+livraison|client|monsieur|madame|mme|mr)\b|\bm\.|(?:^|\s)[àa]\s+m\./i;
// intitule qui ouvre le bloc du client / destinataire (copie appli) ; ligne d'adresse postale (rue, code postal + ville)
const RE_MARQUEUR_CLIENT = /^\s*(?:destinataire|client|livr[ée]e?\s+[àa]|adresse\s+de\s+livraison|factur[ée]e?\s+[àa]|ship\s+to|bill\s+to|sold\s+to)\b/i;
const RE_ADRESSE_POSTALE = /\b(?:rue|avenue|av\.|chauss[ée]e|boulevard|bd|straat|laan|route|place)\b|\b\d{4,5}\s+[A-Za-zÀ-ÿ]{3,}/i;
const RE_DATE = /\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/;

function nettoyerJeton(s) {
  return String(s || '').replace(/[./-]+$/, '');
}

export function extraireIdentification(lignesTexte) {
  const L = (lignesTexte || []).map((x) => String(x || '').trim()).filter(Boolean);
  const id = { emetteur: null, numeros: [], date: null, reference_client: null, transporteur: null, colis: null, page: null };
  const ajouter = (v) => {
    const n = nettoyerJeton(v);
    if (n && /\d/.test(n) && !/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(n) && !id.numeros.includes(n)) id.numeros.push(n);
  };
  // emetteur : ligne de raison sociale, sinon premiere ligne non vide hors titre / adresse / date ;
  // tout ce qui suit un intitule de bloc client / destinataire est exclu (c'est l'adresse du client, jamais l'emetteur)
  const iClient = L.findIndex((l) => RE_MARQUEUR_CLIENT.test(l));
  const Lemet = iClient < 0 ? L : L.slice(0, iClient);
  for (const l of Lemet) {
    const m = RE_SOCIETE.exec(l);
    if (m && !RE_TITRE.test(l) && !RE_MOT_TITRE.test(l) && !RE_ADRESSE_CLIENT.test(l)) { id.emetteur = l.slice(0, m.index + m[0].length).trim(); break; }
  }
  if (!id.emetteur) {
    for (const l of Lemet) {
      if (RE_TITRE.test(l) || RE_MOT_TITRE.test(l) || RE_ADRESSE_CLIENT.test(l) || RE_ADRESSE_POSTALE.test(l) || RE_DATE.test(l) || /^\d/.test(l)) continue;
      const e = l.replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (/[A-Za-zÀ-ÿ]{3}/.test(e)) { id.emetteur = e; }
      break;
    }
  }
  const forts = [
    new RegExp('(?:bon\\s+de\\s+livraison|delivery\\s+note|lieferschein|\\bBL\\b)\\s*(?:n\\s*[\\u00b0\\u00ba]|n[o\\u00b0.]\\.?|nr\\.?|num[e\\u00e9]ro|number|#)?\\s*[:.]?\\s*' + RE_NUM_TOKEN, 'gi'),
    new RegExp('(?<!date\\s+de\\s)livraison\\s*(?:n\\s*[\\u00b0\\u00ba]|no\\.?|nr\\.?|num[e\\u00e9]ro)\\s*[:.]?\\s*' + RE_NUM_TOKEN, 'gi'),
    new RegExp('(?:n\\s*[\\u00b0\\u00ba]|no\\.?|num[e\\u00e9]ro)\\s*(?:de\\s+)?(?:bon\\s+de\\s+livraison|BL)\\s*[:.]?\\s*' + RE_NUM_TOKEN, 'gi'),
  ];
  for (const l of L) {
    for (const re of forts) { re.lastIndex = 0; let m; while ((m = re.exec(l))) ajouter(m[1]); }
    if (!id.page) { const m = /\bpage\s*(\d+\s*\/\s*\d+)/i.exec(l) || /\bp\.\s*(\d+\s*\/\s*\d+)/i.exec(l); if (m) id.page = m[1].replace(/\s+/g, ''); }
    if (!id.date) {
      const m = new RegExp('(?:date\\s*(?:de\\s*livraison|du\\s*document|bl)?|delivery\\s*date|livr[e\\u00e9]\\w*\\s*le)\\s*:?\\s*(' + RE_DATE.source + ')', 'i').exec(l);
      if (m) id.date = m[1];
    }
    if (!id.reference_client) {
      const m = new RegExp('(?:votre\\s+(?:commande|r[e\\u00e9]f(?:[e\\u00e9]rence)?)|vos?\\s+r[e\\u00e9]f|notre\\s+commande|your\\s+(?:order|ref\\w*))\\s*\\.?\\s*(?:n\\s*[\\u00b0\\u00ba]|no\\.?)?\\s*[:.]?\\s*' + RE_NUM_TOKEN, 'i').exec(l) || /\b(BC[-\s]?\d[A-Za-z0-9/.-]*)/i.exec(l);
      if (m && /\d/.test(m[1])) id.reference_client = nettoyerJeton(m[1]);
    }
    if (!id.transporteur) {
      const m = /transporteur\s*:?\s*(.+?)(?=\s+(?:colis|date|votre|notre|page|n\s*[°º])\b|$)/i.exec(l);
      if (m && m[1].trim()) id.transporteur = m[1].trim();
    }
    if (!id.colis) { const m = /\b(?:nombre\s+de\s+colis|nb\.?\s*colis|colis|packages?)\s*:?\s*(\d+)/i.exec(l); if (m) id.colis = m[1]; }
  }
  if (!id.date) { for (const l of L) { const m = RE_DATE.exec(l); if (m) { id.date = m[0]; break; } } }
  return id;
}

// Garde-fou (copie appli) : le document n'est exploitable que s'il a un tableau avec des lignes, et si les quantites sont lisibles sur au moins la moitie d'entre elles.
// Retourne null (lecture exploitable), 'tableau-introuvable' ou 'trop-incertaine'.
export function verdictLecture(t) {
  if (!t.entete || !t.rows.length) return 'tableau-introuvable';
  const detail = t.rows.filter((r) => !RE_IGNORE.test(strip((r.desig || '') + ' ' + (r.ref || ''))));
  if (detail.length && detail.filter((r) => r.qty != null && r.qty > 0).length * 2 < detail.length) return 'trop-incertaine';
  return null;
}

export function analyser(itemsIn, stock) {
  const t = lireTableau(itemsIn);
  t.verdict = verdictLecture(t);
  if (t.verdict) { // aucune valeur aberrante : identification vide, aucune ligne proposee
    t.identification = extraireIdentification([]);
    t.rows = [];
    t.controle = controleArith(t);
    return t;
  }
  t.identification = extraireIdentification(t.indexEntete != null ? t.texteLignes.slice(0, t.indexEntete) : t.texteLignes);
  for (const row of t.rows) {
    // colonne reference non detectee (en-tete illisible) : le premier mot de la designation peut etre un EAN ou une reference exacte
    if (!row.ref && row.desig) {
      const w = row.desig.split(/\s+/)[0].replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, '');
      const x = w.length >= 4 ? chercherId1(w, stock) : null;
      if (x && (x.type === 'ean' || x.type === 'ref') && x.items.length === 1) { row.ref = w; row.desig = row.desig.slice(row.desig.indexOf(w) + w.length).trim(); }
    }
    const idExact = chercherId(row.ref, stock);
    const idFort = idExact && idExact.items.length === 1 && (idExact.type === 'ean' || idExact.type === 'ref');
    const texteIgn = strip((row.desig || '') + ' ' + (row.ref || ''));
    if (RE_IGNORE.test(texteIgn) && !idFort) { row.statut = 'ignoree'; continue; }
    if (!row.desig && !row.ref) { row.statut = 'ignoree'; continue; }
    row.proposition = proposer(row, stock, t.identification && t.identification.emetteur);
    row.statut = 'article';
  }
  t.controle = controleArith(t);
  return t;
}

// ---------- controle arithmetique ----------
export function voyant(ecart) {
  const c = Math.round(Math.abs(ecart) * 100); // en centimes entiers : pas d'erreur de virgule flottante a la limite
  return c === 0 ? 'vert' : c <= 5 ? 'orange' : 'rouge';
}
export const r2 = (x) => Math.round(x * 100) / 100;

export function controleArith(t) {
  // somme des quantites livrees (lignes non ignorees) comparee au "total pieces" lu, si le document en porte un
  const qrows = t.rows.filter((r) => r.statut !== 'ignoree');
  const sq = qrows.reduce((s, r) => s + (r.qty || 0), 0);
  const pieces = t.totaux.pieces != null ? { somme: sq, lu: t.totaux.pieces, ecart: sq - t.totaux.pieces, voyant: sq === t.totaux.pieces && qrows.every((r) => r.qty != null) ? 'vert' : 'rouge' } : null;
  if (!t.prix) return { applicable: false, raison: 'Document sans prix : le controle quantite x prix ne s\'applique pas.', pieces };
  const lignes = [];
  let somme = 0, nbSansMontant = 0;
  for (const row of t.rows) {
    const c = { ligne: row.desig || row.ref, etat: 'sans controle', attendu: null, ecart: null };
    if (row.montant != null) somme += row.montant; else nbSansMontant++;
    if (row.qty != null && row.pu != null && row.montant != null) {
      const rem = row.remise != null ? row.remise : 0;
      const att = row.qty * row.pu * (1 - rem / 100);
      const ecart = r2(row.montant - att); // ecart arrondi au centime AVANT la comparaison a la tolerance (evite 0,0300000000000011 > 0,03)
      const tolArr = r2(0.01 + 0.005 * row.qty);
      c.attendu = r2(att); c.ecart = ecart;
      c.etat = Math.abs(ecart) <= 0.011 ? 'vert' : Math.abs(ecart) <= tolArr ? 'orange' : 'rouge';
    } else if (t.colonnes.includes('pu') && row.statut !== 'ignoree' && (row.pu == null || row.montant == null)) {
      c.etat = 'rouge'; c.note = 'prix ou montant non lu';
    } else if (row.montant == null) { c.etat = 'rouge'; c.note = 'montant non lu'; }
    lignes.push(c);
    row.controle = c;
  }
  const out = { applicable: true, lignes, somme: r2(somme), nbSansMontant, pieces };
  const T = t.totaux;
  let base = T.ht;
  let baseNom = 'Total HT lu';
  if (base == null && T.ttc != null && T.tva != null) { base = r2(T.ttc - T.tva); baseNom = 'TTC - TVA'; }
  out.base = { nom: baseNom, lu: base, ecart: base != null ? r2(somme - base) : null, voyant: base != null ? voyant(somme - base) : 'gris' };
  if (T.tva != null && base != null && T.tvaTaux != null) {
    const att = r2((base * T.tvaTaux) / 100);
    out.tva = { lu: T.tva, attendu: att, ecart: r2(T.tva - att), voyant: voyant(T.tva - att) };
  } else out.tva = { lu: T.tva, voyant: 'gris' };
  if (T.ttc != null && base != null && T.tva != null) {
    const att = r2(base + T.tva);
    out.ttc = { lu: T.ttc, attendu: att, ecart: r2(T.ttc - att), voyant: voyant(T.ttc - att) };
  } else out.ttc = { lu: T.ttc, voyant: 'gris' };
  out.nbRouge = lignes.filter((l) => l.etat === 'rouge').length;
  out.global = out.nbRouge > 0 || [out.base, out.tva, out.ttc].some((x) => x.voyant === 'rouge') ? 'rouge'
    : [out.base, out.tva, out.ttc].some((x) => x.voyant === 'orange') || lignes.some((l) => l.etat === 'orange') ? 'orange'
    : out.base.voyant === 'gris' ? 'gris' : 'vert';
  return out;
}

// ---------- evaluation contre l'attendu ----------
// retourne les compteurs demandes. attendu = entree de attendu.json
export function evaluer(t, attendu) {
  const art = t.rows.filter((r) => r.statut === 'article');
  const ign = t.rows.filter((r) => r.statut === 'ignoree');
  const res = { attendues: attendu.lignes.length, ok: 0, averifier: 0, nonreco: 0, fpHaut: 0, fpBas: 0, qteFausseHaut: 0, details: [] };
  const utilisees = new Set();
  for (const a of attendu.lignes) {
    const cand = art.filter((r) => r.proposition.item && r.proposition.item.ref === a.article && !utilisees.has(r));
    const r = cand[0];
    if (!r) {
      // ligne attendue absente, ou classee "non reconnu"
      res.nonreco++; res.details.push(a.article + ' : non reconnue/absente');
      continue;
    }
    utilisees.add(r);
    const qok = r.qty === a.qte;
    const cl = r.proposition.classe;
    if (cl === 'reconnu' && qok) { res.ok++; res.details.push(a.article + ' : OK'); }
    else if (cl === 'reconnu' && !qok) { res.qteFausseHaut++; res.averifier++; res.details.push(a.article + ' : reconnu mais quantite lue ' + r.qty + ' (attendu ' + a.qte + ')'); }
    else { res.averifier++; res.details.push(a.article + ' : a verifier (qte ' + (qok ? 'ok' : 'lue ' + r.qty + ' attendu ' + a.qte) + ')'); }
  }
  // lignes en trop : tout ce qui est propose comme article sans etre attendu
  for (const r of art) {
    if (utilisees.has(r)) continue;
    const cl = r.proposition.classe;
    if (cl === 'non reconnu') continue; // signalee sans proposition : comportement correct pour un inconnu
    const nom = r.proposition.item ? r.proposition.item.ref : '?';
    if (cl === 'reconnu') { res.fpHaut++; res.details.push('FAUX POSITIF HAUT : "' + (r.desig || r.ref) + '" -> ' + nom); }
    else { res.fpBas++; res.details.push('fausse proposition a verifier : "' + (r.desig || r.ref) + '" -> ' + nom); }
  }
  // ligne de port etc. prise pour un article : deja comptee ci-dessus (statut article). Les ignorees sont correctes.
  res.ignorees = ign.length;
  res.inconnuesSignalees = art.filter((r) => r.proposition.classe === 'non reconnu').length;
  res.lignesLues = t.rows.length;
  return res;
}
