/* Service worker : mode hors ligne de Scanpocket (cache distinct de l'ancienne application, meme origine).
   Le nom du cache porte l'environnement (dev ici ; la livraison en fait scanpocket-test-v et scanpocket-prod-v pour les autres dossiers : une seule source) et seules les anciennes versions du cache de CET environnement sont supprimees. */
var VERSION_CACHE = 6; /* à augmenter seulement si la logique du cache change */
var PREFIX = 'scanpocket-test-v';
var V = PREFIX + VERSION_CACHE;
var FAM = new RegExp('^' + PREFIX + '\\d+$');
/* La PRODUCTION est à la RACINE du site, DEV et TEST dans les sous-dossiers dev/ et test/ : le service worker de la racine ne doit ni contrôler ni mettre en cache ces pages
   (chaque environnement a son propre service worker, avec sa portée et son cache). BASE = dossier de CE service worker ; pour dev/ et test/ la liste ne correspond à rien. */
var BASE = new URL('./', self.location.href).pathname;
var AUTRES_ENVIRONNEMENTS = ['dev/', 'test/'];
/* Dossier bl/ (lecture des bons de livraison : Tesseract, pdf.js, 3 coeurs wasm de 4 Mo). AUCUN precache : un fichier n'est garde qu'apres avoir ete demande par le navigateur (cache A L'USAGE).
   Cache DISTINCT, cache d'abord : scanpocket-<env>-bl-<id>, ou <id> = 8 premiers caracteres de la somme de controle de TOUT le dossier bl/ (calculee a la publication, qui remplace 'local' ci-dessous) :
   un fichier de bl/ change => nouvelle somme => nouveau cache, l'ancien est supprime a l'activation. Un nom par environnement (les trois partagent l'origine) et jamais le prefixe de l'ancienne appli (inventaire-). */
var PREFIX_BL = 'scanpocket-test-bl-';
var BL_VERSION = 'd4b4c8e4';
var V_BL = PREFIX_BL + BL_VERSION;
var FAM_BL = new RegExp('^' + PREFIX_BL + '[0-9a-z]+$');
var DOSSIER_BL = BASE + 'bl/';

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(V).then(function (c) {
      return Promise.all(['./'].map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return (FAM.test(k) && k !== V) || (FAM_BL.test(k) && k !== V_BL); }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  /* Seulement http(s) : les requêtes d'extensions du navigateur (chrome-extension:, etc.) ne sont pas mises en cache */
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  /* La synchronisation Firebase ne passe jamais par le cache */
  if (/firebaseio\.com$|firebasedatabase\.app$/.test(u.hostname)) return;
  /* Les pages et fichiers des AUTRES environnements (sous-dossiers de la racine) ne passent jamais par ce service worker : réseau normal */
  if (u.origin === location.origin && AUTRES_ENVIRONNEMENTS.some(function (d) { return u.pathname.indexOf(BASE + d) === 0; })) return;

  /* Fichiers de bl/ : cache d'abord (cache distinct V_BL, rempli a l'usage), puis reseau ; seule une reponse 200 complete est gardee (pas de 206, pas d'erreur) ; requetes Range : reseau normal */
  if (u.origin === location.origin && u.pathname.indexOf(DOSSIER_BL) === 0) {
    if (r.headers.has('range')) return;
    e.respondWith(
      caches.open(V_BL).then(function (c) {
        return c.match(r).then(function (m) {
          return m || fetch(r).then(function (res) {
            if (res.status === 200) c.put(r, res.clone()).catch(function () {});
            return res;
          });
        });
      })
    );
    return;
  }

  if (r.mode === 'navigate' || u.origin === location.origin) {
    /* Page de l'app : réseau d'abord (pour recevoir les mises à jour), cache si hors ligne.
       no-cache = on revalide toujours auprès du serveur (sinon le navigateur peut resservir une ancienne version pendant ~10 minutes) */
    e.respondWith(
      fetch(r, { cache: 'no-cache' }).then(function (res) {
        var cp = res.clone();
        caches.open(V).then(function (c) { return c.put(r, cp); }).catch(function () {});
        return res;
      }).catch(function () {
        return caches.match(r, { ignoreSearch: true }).then(function (m) { return m || caches.match('./'); });
      })
    );
  } else {
    /* Bibliothèque de scan et polices : cache d'abord */
    e.respondWith(
      caches.match(r).then(function (m) {
        return m || fetch(r).then(function (res) {
          var cp = res.clone();
          caches.open(V).then(function (c) { return c.put(r, cp); }).catch(function () {});
          return res;
        });
      })
    );
  }
});
