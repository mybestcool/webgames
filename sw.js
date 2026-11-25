'use strict';
importScripts('./offline-files.js?build=5d9440f086b92696b8cb');

const root = self.registration.scope;
const prefix = 'after-school-v1:' + new URL(root).pathname + ':';
const marker = new URL('.offline-complete', root).href;
const jobs = new Map();
const sharedCache = prefix + 'shared';
const sharedTransfers = new Map();
const largeFileSize = 1024 * 1024;
const largeLimit = self.navigator.connection?.saveData ? 1 : 3;
let activeLarge = 0;
const waitingLarge = [];
const storageLock = prefix + 'maintain-releases';
const key = (id, version) => prefix + id + ':' + version;
const totalSize = release => Object.values(release.files).reduce((n, item) => n + item.size, 0);
const pointer = id => new URL('.installed/' + id, root).href;
const info = ({label, version}) => ({label, version});
const meta = () => caches.open(prefix + 'installed');
let catalogRequest;

async function completed(name) {
  return (await caches.match(marker, {cacheName:name})) != null;
}
async function installed(id) {
  const db = await meta();
  const record = await db.match(pointer(id));
  if (record) {
    const saved = await record.json();
    if (await completed(key(id, saved.version))) return saved;
  }
  // Adopt complete cartridges from the previous PWA, including its plain-text marker.
  const start = prefix + id + ':';
  for (const name of (await caches.keys()).reverse()) {
    if (!name.startsWith(start) || !await completed(name)) continue;
    const version = name.slice(start.length);
    const release = CLUB_FILES.games[id];
    const saved = {version, label:version === release.version ? release.label : ''};
    await db.put(pointer(id), Response.json(saved));
    return saved;
  }
  return null;
}
async function catalog() {
  if (!self.navigator.onLine) throw new Error('设备离线');
  if (!catalogRequest) {
    const cancel = new AbortController();
    const timer = setTimeout(() => cancel.abort(), 5000);
    catalogRequest = fetch(new URL('cartridges.json', root), {cache:'no-store', signal:cancel.signal})
      .then(async response => {
        if (!response.ok) throw new Error('无法检查卡带版本');
        const list = await response.json();
        for (const id of Object.keys(CLUB_FILES.games)) {
          const release = list[id];
          if (!release || !/^[0-9a-f]{20}$/.test(release.version) ||
              !Object.hasOwn(release.files, 'games/' + id + '/index.html') ||
              Object.entries(release.files).some(([file, item]) =>
                !(file.startsWith('games/' + id + '/') || file.startsWith('shared/')) ||
                !/^[a-zA-Z0-9_./-]+$/.test(file) || file.includes('..') || file.includes('//') ||
                !Number.isSafeInteger(item.size) || item.size < 0 || !/^[0-9a-f]{64}$/.test(item.sha256))) {
            throw new Error('卡带版本清单无效');
          }
        }
        return list;
      }).finally(() => { clearTimeout(timer); catalogRequest = undefined; });
  }
  return catalogRequest;
}
async function checksum(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
async function fetchFile(url, file, progress, signal, cacheMode) {
  const isDocument = url.pathname.endsWith('.html');
  const source = isDocument ? new URL('pwa-documents/' + url.href.slice(root.length) + '.bin', root) : url;
  const response = await fetch(source, {cache:cacheMode, credentials:'same-origin', signal});
  if (!response.ok || new URL(response.url).origin !== new URL(root).origin) throw new Error('资源下载失败');
  const bytes = new Uint8Array(file.size);
  let offset = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) { await reader.cancel(); throw new Error('资源长度不符'); }
      bytes.set(value, offset);
      offset += value.length;
      progress(offset);
    }
  } else {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length === bytes.length) { bytes.set(data); offset = data.length; }
  }
  if (offset !== file.size || await checksum(bytes) !== file.sha256) throw new Error('资源校验失败，请重试');
  // A Fetch body is already decoded by the browser. Store a clean, uncompressed response.
  return new Response(bytes, {headers:{
    'Content-Type':isDocument ? 'text/html; charset=utf-8' : response.headers.get('Content-Type') || 'application/octet-stream',
    'Content-Length':String(offset), 'X-Club-SHA256':file.sha256,
  }});
}
async function reusable(cache, url, file) {
  if (!cache) return null;
  const response = await cache.match(url);
  if (!response) return null;
  const hash = response.headers.get('X-Club-SHA256');
  if (hash) return hash === file.sha256 ? response : null;
  // Releases before 1.1 stored no hashes. Verify the old bytes before reusing them.
  return await checksum(await response.clone().arrayBuffer()) === file.sha256 ? response : null;
}
// 1.0.x kept Brotli pieces under each game. Adopt a byte-identical piece
// even when its new canonical URL belongs to the shared engine.
async function legacyPart(path, file) {
  if (!path.endsWith('.bin')) return null;
  const shared = path.startsWith('shared/');
  const ids = shared ? Object.keys(CLUB_FILES.games) : [path.split('/')[1]];
  const suffix = (shared ? 'wasm' : 'pck') + '.' + file.sha256.slice(0, 16) + '.bin';
  for (const id of ids) {
    const copy = await reusable(caches, new URL('games/' + id + '/game.' + suffix, root), file);
    if (copy) return copy;
  }
  return null;
}
async function storeFile(cache, url, file, copy, count) {
  if (await reusable(cache, url, file)) return;
  const previous = await copy();
  if (previous) { await cache.put(url, previous); return; }
  if (file.size < largeFileSize) return fetchAndStore(cache, url, file, count);
  // Share the large-buffer budget across both background installs and live frames.
  if (activeLarge === largeLimit) await new Promise(resolve => waitingLarge.push(resolve));
  else activeLarge++;
  try { await fetchAndStore(cache, url, file, count); }
  finally {
    const next = waitingLarge.shift();
    if (next) next();
    else activeLarge--;
  }
}
async function fetchAndStore(cache, url, file, count) {
  // Reuse the browser's copy only after verifying it against this release.
  // A stale HTTP entry, interrupted stream or transient CDN error gets a fresh request.
  for (const mode of ['force-cache', 'reload']) {
    const cancel = new AbortController();
    let timer, response;
    function tick(n) {
      clearTimeout(timer);
      timer = setTimeout(() => cancel.abort(), 45000);
      count(n);
    }
    tick(0);
    try { response = await fetchFile(url, file, tick, cancel.signal, mode); }
    catch (error) {
      if (mode === 'reload' || !self.navigator.onLine) throw error;
      continue;
    } finally { clearTimeout(timer); }
    await cache.put(url, response);
    return;
  }
}
// A launching frame, the cache-all action and another title may all request the
// same engine. Keep one verified copy and join its in-flight transfer.
async function prepareShared(path, file, stage, count = () => {}) {
  let job = sharedTransfers.get(path);
  if (!job) {
    const url = new URL(path, root);
    job = {listeners:new Set(), loaded:0};
    job.done = caches.open(sharedCache).then(cache => storeFile(cache, url, file,
      async () => await reusable(stage, url, file) || await legacyPart(path, file), n => {
        job.loaded = n;
        for (const notify of job.listeners) notify(n);
      })).finally(() => sharedTransfers.delete(path));
    sharedTransfers.set(path, job);
  }
  job.listeners.add(count);
  count(job.loaded);
  try { await job.done; } finally { job.listeners.delete(count); }
}
async function download(id, release, previous, notify, fileReady) {
  const name = key(id, release.version);
  const cache = await caches.open(name);
  const old = previous && previous.version !== release.version ? await caches.open(key(id, previous.version)) : null;
  const stageName = prefix + 'download:' + id;
  const stage = id !== 'shell' && await caches.has(stageName) ? await caches.open(stageName) : null;
  const files = Object.entries(release.files);
  // Start the loader while the large engine and resource packs are in flight.
  if (id !== 'shell') {
    const priority = path => path.endsWith('/index.html') ? 0 : path.endsWith('/release.json') ? 1 :
      path.endsWith('.bin') ? 2 : path.endsWith('.txt') ? 4 : 3;
    files.sort(([a], [b]) => priority(a) - priority(b));
  }
  const total = totalSize(release);
  const counts = new Map();
  let loaded = 0, last = 0;
  function count(file, n) {
    loaded += n - (counts.get(file) || 0);
    counts.set(file, n);
    if (Date.now() - last >= 120) {
      last = Date.now();
      notify({loaded, total, percent:Math.min(99, Math.floor(100 * loaded / total))});
    }
  }
  notify({loaded:0, total, percent:0});
  let failed = false;
  async function next(queue) {
    for (const [path, file] of queue) {
      if (failed) break;
      const url = new URL(path, root);
      const update = n => count(path, n);
      if (path.startsWith('shared/')) await prepareShared(path, file, stage, update);
      else await storeFile(cache, url, file,
        async () => await reusable(old, url, file) || await reusable(stage, url, file) || await legacyPart(path, file), update);
      count(path, file.size);
      fileReady(path);
    }
  }
  // Keep large buffers bounded on phones. Tiny loader and license files need
  // not wait behind multi-megabyte transfers on a high-latency connection.
  const large = files.filter(([, file]) => file.size >= largeFileSize).values();
  const small = files.filter(([, file]) => file.size < largeFileSize).values();
  const workers = [...Array.from({length:largeLimit}, () => next(large)), ...Array.from({length:4}, () => next(small))];
  try { await Promise.all(workers); }
  catch (error) { failed = true; await Promise.allSettled(workers); throw error; }
  await cache.put(marker, Response.json({...info(release), shared:files.map(([path]) => path).filter(p => p.startsWith('shared/'))}));
  if (stage) await caches.delete(stageName);
  notify({loaded:total, total, percent:100});
}
async function prepare(id, release, previous, listener) {
  const name = key(id, release.version);
  if (await completed(name)) return;
  let job = jobs.get(name);
  if (!job) {
    job = {listeners:new Set(), progress:null, release, waiting:new Map(), available:new Set()};
    const run = () => download(id, release, previous, progress => {
      job.progress = progress;
      for (const send of job.listeners) send(progress);
    }, path => {
      job.available.add(path);
      job.waiting.get(path)?.resolve();
      job.waiting.delete(path);
    });
    const locks = self.navigator.locks;
    job.done = (locks ? locks.request(storageLock, {mode:'shared'}, run) : run()).finally(() => {
      for (const waiter of job.waiting.values()) waiter.resolve();
      jobs.delete(name);
    });
    jobs.set(name, job);
  }
  if (listener) {
    job.listeners.add(listener);
    if (job.progress) listener(job.progress);
  }
  try { await job.done; } finally { job.listeners.delete(listener); }
}
async function trimGames(id, current, previous) {
  const start = prefix + id + ':';
  const clients = await self.clients.matchAll({includeUncontrolled:true});
  const keep = new Set([current, previous]);
  for (const client of clients) {
    const pinned = matchGame(new URL(client.url));
    if (pinned?.id === id) keep.add(pinned.version);
  }
  const retired = new Set();
  for (const name of await caches.keys()) {
    if (name.startsWith(start) && !keep.has(name.slice(start.length)) && !jobs.has(name)) {
      const record = await caches.match(marker, {cacheName:name});
      const release = await record?.json().catch(() => null);
      for (const path of release?.shared || []) retired.add(path);
      await caches.delete(name);
    }
  }
  if (!retired.size || !self.navigator.locks) return;
  // An old pinned game can still need a runtime after the lobby switches.
  // Never collect during a game download, including one owned by another worker.
  await self.navigator.locks.request(storageLock, async () => {
    for (const game of Object.values(CLUB_FILES.games)) {
      for (const path of Object.keys(game.files)) retired.delete(path);
    }
    for (const name of await caches.keys()) {
      if (!name.startsWith(prefix) || name === sharedCache) continue;
      const record = await caches.match(marker, {cacheName:name});
      const saved = await record?.json().catch(() => null);
      for (const path of saved?.shared || []) retired.delete(path);
    }
    const cache = await caches.open(sharedCache);
    for (const path of retired) await cache.delete(new URL(path, root));
  });
}
async function prepareGame(id, mode, notify) {
  const previous = await installed(id);
  if (previous && mode === 'missing') return previous;
  if (previous && (mode === 'launch' || mode === 'play')) return {...previous, checkAfterLoad:true};
  let releases;
  // The installed worker already contains an integrity-checked catalog. Cold
  // play can start from it without a round trip before opening the game frame.
  try { releases = !previous && (mode === 'play' || mode === 'missing') ? CLUB_FILES.games : await catalog(); }
  catch {
    if (previous) return previous;
    releases = CLUB_FILES.games;
  }
  const release = releases[id];
  if (!previous && !self.navigator.onLine) throw new Error('这盘卡带尚未缓存，请联网后重试');
  try {
    await prepare(id, release, previous, progress => notify({...progress, updating:Boolean(previous),
      startVersion:mode === 'play' && !previous ? release.version : undefined}));
  } catch (error) {
    if (previous) return {...previous, fallback:true};
    throw error;
  }
  const saved = info(release);
  await (await meta()).put(pointer(id), Response.json(saved));
  if (previous?.version !== saved.version) await trimGames(id, saved.version, previous?.version);
  return saved;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const start = prefix + 'shell:';
    const old = (await caches.keys()).reverse().find(name => name.startsWith(start) && name !== key('shell', CLUB_FILES.shell.version));
    await prepare('shell', CLUB_FILES.shell, old ? {version:old.slice(start.length)} : null);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    let legacy = false;
    for (const name of names) {
      if (name.startsWith(prefix + 'shell:') && name !== key('shell', CLUB_FILES.shell.version)) {
        if (!await caches.match(new URL('app-version.js', root), {cacheName:name})) legacy = true;
        await caches.delete(name);
      }
    }
    await self.clients.claim();
    if (legacy) {
      // 1.0 has no controllerchange listener. Refresh its idle lobby once.
      // Its running Godot iframe / save lock must outlive the worker upgrade.
      const windows = await self.clients.matchAll({type:'window'});
      const locks = await self.navigator.locks?.query().catch(() => null);
      if (windows.some(w => matchGame(new URL(w.url))) ||
          locks?.held.some(lock => lock.name === 'cartridge-club:/userfs')) return;
      for (const tab of windows) {
        const url = new URL(tab.url);
        if (url.href.startsWith(root) &&
            ['', 'index.html'].includes(url.pathname.slice(new URL(root).pathname.length))) {
          // A navigation waits for activation, so it must not extend this event.
          tab.navigate(tab.url).catch(() => {});
        }
      }
    }
  })());
});
self.addEventListener('message', event => {
  const port = event.ports[0], data = event.data;
  if (!port || !data) return;
  event.waitUntil((async () => {
    try {
      if (data.type === 'status') {
        const versions = {}, sizes = {}, ready = [];
        for (const [id, target] of Object.entries(CLUB_FILES.games)) {
          const saved = await installed(id);
          versions[id] = saved || info(target);
          sizes[id] = totalSize(target);
          if (saved) ready.push(id);
        }
        port.postMessage({type:'done', shell:info(CLUB_FILES.shell), ready, versions, sizes});
      } else if (data.type === 'prepare' && Object.hasOwn(CLUB_FILES.games, data.id)) {
        const saved = await prepareGame(data.id, data.mode, p => port.postMessage({type:'progress', ...p}));
        port.postMessage({type:'done', ...saved});
      } else throw new Error('未知卡带');
    } catch (error) {
      port.postMessage({type:'error', message:error.name === 'QuotaExceededError' ? '设备存储空间不足' : error.message});
    } finally { port.close(); }
  })());
});
function matchGame(url) {
  const path = url.pathname.slice(new URL(root).pathname.length);
  const match = /^games\/([a-z0-9-]+)(?:~([0-9a-f]{20}))?\/(.*)$/.exec(path);
  return match && Object.hasOwn(CLUB_FILES.games, match[1]) ?
    {id:match[1], version:match[2], path:'games/' + match[1] + '/' + (match[3] || 'index.html')} : null;
}
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET' || !url.href.startsWith(root)) return;
  const path = url.pathname.slice(new URL(root).pathname.length) || 'index.html';
  const game = matchGame(url);
  if (game && game.path.endsWith('/index.html') && request.mode === 'navigate' && request.destination === 'document') {
    event.respondWith(Response.redirect(new URL('?game=' + game.id, root)));
  } else if (game) {
    event.respondWith((async () => {
      const version = game.version || (await installed(game.id))?.version;
      if (version) {
        const options = {cacheName:key(game.id, version)};
        const file = new URL(game.path, root);
        const job = jobs.get(options.cacheName);
        let cached = await caches.match(file, options);
        if (cached) return cached;
        if (job && Object.hasOwn(job.release.files, game.path)) {
          if (!job.available.has(game.path) && jobs.get(options.cacheName) === job) {
            let waiter = job.waiting.get(game.path);
            if (!waiter) {
              let resolve;
              const promise = new Promise(done => { resolve = done; });
              waiter = {promise, resolve};
              job.waiting.set(game.path, waiter);
            }
            await waiter.promise;
          }
          cached = await caches.match(file, options);
          if (cached) return cached;
        }
      }
      return game.version ? Response.error() : fetch(request);
    })());
  } else if (path.startsWith('shared/')) {
    event.respondWith((async () => {
      const url = new URL(path, root);
      const cache = await caches.open(sharedCache);
      const hit = await cache.match(url);
      if (hit) return hit;
      const releases = [...Array.from(jobs.values(), job => job.release), ...Object.values(CLUB_FILES.games)];
      const file = releases.find(release => Object.hasOwn(release.files, path))?.files[path];
      if (!file) return fetch(request);
      await prepareShared(path, file, null);
      return await cache.match(url) || Response.error();
    })());
  } else if (Object.hasOwn(CLUB_FILES.shell.files, path)) {
    event.respondWith((async () => {
      const cached = await caches.match(new URL(path, root), {cacheName:key('shell', CLUB_FILES.shell.version)});
      return cached || fetch(request);
    })());
  }
});
