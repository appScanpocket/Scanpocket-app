# Licences des bibliotheques de lecture (EnvDev\bl\vendor)

Toutes sont gratuites, sans cle ni service en ligne, et tournent dans le navigateur (rien n'est envoye). Les fichiers LICENSE d'origine sont conserves a cote des bibliotheques.

| Composant | Numero | Licence | Dossier | Fichiers gardes |
|---|---|---|---|---|
| pdf.js (paquet pdfjs-dist) | 6.4.299 | Apache-2.0 | vendor\pdfjs | build\pdf.min.mjs, build\pdf.worker.min.mjs, LICENSE |
| Tesseract.js | 7.0.0 | Apache-2.0 | vendor\tesseract | dist\tesseract.min.js, dist\worker.min.js, LICENSE.md |
| Tesseract.js-core | 7.0.0 | Apache-2.0 (contient Leptonica, licence de type BSD) | vendor\tesseract-core | les 3 coeurs -lstm (relaxedsimd, simd, sans SIMD), LICENSE |
| Donnees de langue francais (@tesseract.js-data/fra) | 1.0.0 | MIT (paquet) ; modeles tessdata_best sous Apache-2.0 | vendor\lang | fra.traineddata.gz |

Provenance : registre npm, copie du jeu allege teste (C:\tmp\pilote_poids\min), identique octet pour octet aux fichiers de Pilote_bonlivraison\vendor.
L'anglais (eng.traineddata.gz, meme licence) n'est pas embarque : voir le mode d'emploi en tete de reglages.js.
