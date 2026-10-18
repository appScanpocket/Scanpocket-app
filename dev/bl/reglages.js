// reglages.js - UNIQUE fichier de reglage de la lecture des bons de livraison (charge a la demande avec l'ecran, jamais au demarrage de l'appli).
// MARCHE ARRIERE vers le jeu complet (francais + anglais) en 3 gestes :
//  1. copier Pilote_bonlivraison\vendor\lang\eng.traineddata.gz dans EnvDev\bl\vendor\lang\ (a cote de fra.traineddata.gz) ;
//  2. mettre LANGUES = ['fra', 'eng'] ci-dessous (+2,95 Mo a telecharger) ;
//  3. publier : l'agent Publication ajoute eng.traineddata.gz a la liste blanche (ou la commande « retour » de l'outil de publication revient a la publication precedente).
// Tout le reste (chemins, taille de la photo) se regle ici, nulle part ailleurs.
export const LANGUES = ['fra'];
export const CIBLE_LARGEUR = 2400; // largeur de l'image envoyee a la lecture : reduite au-dela, agrandie (jusqu'a x4) en dessous ; ne pas descendre sous 2400 (mesure)

const base = new URL('./', import.meta.url).href; // dossier EnvDev/bl/ (sur le site : dev/bl/, test/bl/ ...)
export const CHEMINS = {
  base,
  moteur: base + 'lecture.js',
  image: base + 'preproc.js',
  tesseract: base + 'vendor/tesseract/dist/tesseract.min.js',
  worker: base + 'vendor/tesseract/dist/worker.min.js',
  coeurs: base + 'vendor/tesseract-core', // DOSSIER : Tesseract choisit tout seul relaxedsimd-lstm, simd-lstm ou lstm selon le navigateur
  langues: base + 'vendor/lang',
  pdf: base + 'vendor/pdfjs/build/pdf.min.mjs',
  pdfWorker: base + 'vendor/pdfjs/build/pdf.worker.min.mjs'
};
