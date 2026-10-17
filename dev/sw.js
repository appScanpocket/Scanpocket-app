/* Service worker : mode hors ligne de Scanpocket (cache distinct de l'ancienne application, meme origine).
   Le nom du cache porte l'environnement (dev ici ; la livraison en fait scanpocket-test-v et scanpocket-prod-v pour les autres dossiers : une seule source) et seules les anciennes versions du cache de CET environnement sont supprimees. */
var VERSION_CACHE = 5; /* à augmenter seulement si la logique du cache change */
var PREFIX = 'scanpocket-dev-v';
var V = PREFIX + VERSION_CACHE;
var FAM = new RegExp('^' + PREFIX + '\\d+$');

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
      return Promise.all(ks.filter(function (k) { return FAM.test(k) && k !== V; }).map(function (k) { return caches.delete(k); }));
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
