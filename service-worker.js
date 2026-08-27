/* ═══════════════════════════════════════════════════════════════
   SERVICE WORKER — Cópia offline do site (100% local, no navegador)
   ▸ Guarda os arquivos do site (HTML + scripts de terceiros usados
     pela interface) no Cache Storage do navegador, para o app abrir
     e funcionar mesmo sem internet.
   ▸ Toda vez que a pessoa entra com internet, busca a versão mais
     nova em segundo plano; se perceber qualquer diferença no
     código, atualiza a cópia local sozinho e avisa a página.
   ▸ NÃO tem nenhuma ligação com o Firebase/Firestore: chamadas de
     login e sincronização de dados (listadas em BYPASS_HOSTS) nunca
     passam por aqui — continuam indo direto pra rede, normalmente.
     Isto cuida só dos arquivos "estáticos" do próprio site.
   ═══════════════════════════════════════════════════════════════ */

// Suba esse número sempre que quiser forçar uma limpeza total do
// cache antigo (ex.: depois de uma mudança grande no site).
const SW_VERSION = 'v1';
const CACHE_NAME = 'calculodasnotas-offline-' + SW_VERSION;

// "Casca" do app: o essencial pra ele abrir offline.
const CORE_ASSETS = [
  './',
  './index.html'
];

// Domínios que nunca devem passar pelo cache offline — são chamadas
// dinâmicas (autenticação, banco de dados, analytics), não arquivos
// do site em si.
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'firebaseapp.com',
  'googleapis.com',
  'google.com',
  'gstatic.com',
  'goatcounter.com',
  'gc.zgo.at'
];

function shouldBypass(url) {
  return BYPASS_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(CORE_ASSETS);
    } catch (e) {
      // Primeira instalação sem internet: sem problema, tenta de novo
      // sozinho na próxima vez que a página carregar com rede.
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Limpa versões antigas do cache, se houver.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Permite que a página force esse Service Worker novo a assumir na
// hora, sem precisar fechar todas as abas abertas.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function notifyClients(type, payload) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach((c) => c.postMessage(Object.assign({ type }, payload)));
}

/* Página (HTML): sempre tenta a rede primeiro, pra pegar qualquer
   alteração nova assim que a pessoa entra com internet. Compara o
   conteúdo novo com o que já estava salvo — só avisa a página quando
   o código realmente mudou (evita ficar avisando à toa). Sem
   internet, cai pra última cópia salva localmente. */
async function networkFirstHTML(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req);
    const old = await cache.match(req);
    let changed = true;
    if (old) {
      try {
        const [oldText, newText] = await Promise.all([old.clone().text(), fresh.clone().text()]);
        changed = oldText !== newText;
      } catch (e) {
        // Não deu pra comparar (ex.: resposta opaca) — assume que mudou.
      }
    }
    await cache.put(req, fresh.clone());
    if (changed) notifyClients('OFFLINE_CACHE_UPDATED', { updatedAt: Date.now(), hadPrevious: !!old });
    return fresh;
  } catch (e) {
    const cached = (await cache.match(req)) || (await cache.match('./index.html')) || (await cache.match('./'));
    if (cached) return cached;
    throw e;
  }
}

/* Demais arquivos (ícones/scripts de terceiros usados pela interface):
   devolve a cópia salva na hora — rápido e funciona offline — e
   atualiza em segundo plano pra próxima visita já vir com a versão
   mais nova, sem travar a atual esperando a rede. */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  return cached || (await networkPromise) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (shouldBypass(url)) return; // deixa o navegador cuidar normalmente, sem cache

  const isNavigation = req.mode === 'navigate' || req.destination === 'document';

  if (isNavigation) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});
