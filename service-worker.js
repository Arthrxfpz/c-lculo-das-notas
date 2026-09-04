/* ═══════════════════════════════════════════════════════════════
   SERVICE WORKER — Cópia offline do site (100% local, no navegador)
   ▸ Guarda os arquivos do site (HTML + scripts de terceiros usados
     pela interface) no Cache Storage do navegador, para o app abrir
     e funcionar mesmo sem internet.
   ▸ Toda vez que a pessoa entra com internet, busca a versão mais
     nova em segundo plano; se for diferente do que já estava salvo,
     APAGA a cópia antiga e guarda a nova no lugar — sempre sob uma
     chave fixa (não importa se a pessoa abriu por "/" ou por
     "/index.html", nunca fica cópia duplicada) — e avisa a página.
   ▸ De quebra, toda vez que o HTML muda de verdade, aproveita e
     limpa do cache qualquer arquivo (ícone/script) que não seja mais
     referenciado por essa versão nova — assim o espaço ocupado não
     cresce pra sempre, mesmo depois de várias atualizações do site.
   ▸ NÃO tem nenhuma ligação com o Firebase/Firestore: chamadas de
     login e sincronização de dados (listadas em BYPASS_HOSTS) nunca
     passam por aqui — continuam indo direto pra rede, normalmente.
     Isto cuida só dos arquivos "estáticos" do próprio site.
   ═══════════════════════════════════════════════════════════════ */

// Suba esse número sempre que quiser forçar uma limpeza total do
// cache antigo (ex.: depois de uma mudança grande no site).
const SW_VERSION = 'v2';
const CACHE_NAME = 'calculodasnotas-offline-' + SW_VERSION;

// Chave única e fixa pro documento principal. Usar sempre a mesma
// chave (em vez da URL exata que a pessoa digitou/abriu) garante que
// "/" e "/index.html" apontem pro MESMO registro no cache — evita
// guardar duas cópias do mesmo arquivo grande e evita a versão errada
// ser servida dependendo de como o site foi aberto.
const HTML_CACHE_KEY = new Request('./index.html');

// Domínios que nunca devem passar pelo cache offline — são chamadas
// dinâmicas (autenticação, banco de dados, analytics), não arquivos
// do site em si.
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'firebaseapp.com',
  'googleapis.com',
  'google.com',
  'googletagmanager.com',
  'google-analytics.com',
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
      const res = await fetch(HTML_CACHE_KEY, { cache: 'no-store' });
      if (res && res.ok) await cache.put(HTML_CACHE_KEY, res.clone());
    } catch (e) {
      // Primeira instalação sem internet: sem problema, tenta de novo
      // sozinho na próxima vez que a página carregar com rede.
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Limpa versões antigas do cache por inteiro, se houver (ex.: depois
    // de subir o SW_VERSION manualmente pra forçar uma limpeza geral).
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

// Lê o HTML novo e monta a lista de arquivos externos (script/link)
// que ele realmente referencia agora — usada logo abaixo pra decidir
// o que pode ser apagado do cache com segurança.
function extractReferencedUrls(html, baseUrl) {
  const urls = new Set();
  const re = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (!raw || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) continue;
    try {
      const u = new URL(raw, baseUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') urls.add(u.href);
    } catch (e) {
      // link inválido/relativo estranho — ignora, não é motivo pra falhar a atualização
    }
  }
  return urls;
}

// Remove do cache qualquer arquivo (que não seja o próprio documento
// HTML) que a versão nova do site não referencia mais — mantém o
// armazenamento enxuto em vez de acumular arquivos de versões antigas
// pra sempre. Roda só quando o HTML mudou de fato e nunca deixa uma
// falha aqui derrubar a atualização em si (é só uma limpeza extra).
async function pruneOrphanedAssets(cache, keepUrls) {
  try {
    const keys = await cache.keys();
    await Promise.all(keys.map(async (req) => {
      if (req.url === HTML_CACHE_KEY.url) return; // nunca apaga o documento principal aqui
      if (!keepUrls.has(req.url)) await cache.delete(req);
    }));
  } catch (e) {
    // limpeza é "nice to have" — nunca deve quebrar a atualização principal
  }
}

/* Página (HTML): sempre tenta a rede primeiro, pra pegar qualquer
   alteração nova assim que a pessoa entra com internet. Compara o
   conteúdo novo com o que já estava salvo — se for diferente, apaga a
   cópia antiga e grava a nova no lugar (sob a chave fixa acima),
   aproveita e limpa arquivos órfãos, e só então avisa a página.
   Sem internet, cai pra última cópia salva localmente. */
async function networkFirstHTML(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req, { cache: 'no-store' });
    const old = await cache.match(HTML_CACHE_KEY);
    let changed = true;
    let freshText = null;
    try {
      freshText = await fresh.clone().text();
      if (old) {
        const oldText = await old.clone().text();
        changed = oldText !== freshText;
      }
    } catch (e) {
      // Não deu pra comparar (ex.: resposta opaca) — assume que mudou.
    }

    // Apaga a versão antiga e grava a nova no lugar, sempre sob a
    // mesma chave — não importa qual URL exata foi requisitada.
    await cache.delete(HTML_CACHE_KEY);
    await cache.put(HTML_CACHE_KEY, fresh.clone());

    if (changed) {
      if (freshText) {
        const keep = extractReferencedUrls(freshText, req.url);
        pruneOrphanedAssets(cache, keep); // roda em segundo plano, não bloqueia a resposta
      }
      notifyClients('OFFLINE_CACHE_UPDATED', { updatedAt: Date.now(), hadPrevious: !!old });
    }
    return fresh;
  } catch (e) {
    const cached = await cache.match(HTML_CACHE_KEY);
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
