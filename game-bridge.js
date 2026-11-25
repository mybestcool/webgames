'use strict';
{
  const embedded = window.parent !== window && new URLSearchParams(location.search).has('club');
  if (window.top === window.self) {
    const game = /\/games\/([a-z0-9-]+)(?:~[a-f0-9]+)?\/(?:index\.html)?$/.exec(location.pathname);
    if (game) location.replace(new URL('../../?game=' + game[1], location.href));
  }
  let filesystem;
  let lastSync = Promise.resolve();
  let queuedSync;
  const syncListeners = new Set();
  let complete = false;
  let lastPercent = -1;
  const downloads = [];
  const direct = embedded && /\/games\/([a-z0-9-]+)\/(?:index\.html)?$/.exec(location.pathname);
  if (direct) {
    const nativeFetch = window.fetch.bind(window);
    const directory = new URL('./', location.href);
    const shared = new URL('../../shared/', directory);
    const stage = 'after-school-v1:' + new URL('../../', directory).pathname + ':download:' + direct[1];
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const name = response.url.slice(directory.href.length);
      const localPack = response.url.startsWith(directory.href) &&
        /^(index\.(?:wasm|pck)|game\.(?:wasm|pck)\.[0-9a-f]+\.bin|data\.[0-9a-f.]+(?:br\.)?bin)$/.test(name);
      const sharedPack = response.url.startsWith(shared.href) && response.url.endsWith('.bin');
      if (response.status === 200 && (localPack || sharedPack)) {
        // The first launch may precede service worker control. Keep the network
        // bytes for the worker to verify before promoting them to an offline release.
        const copy = response.clone();
        downloads.push((async () => {
          const cache = await caches.open(stage);
          await cache.put(response.url, new Response(copy.body, {headers:{
            'Content-Type':response.headers.get('Content-Type') || 'application/octet-stream',
          }}));
        })().catch(() => {}));
      }
      return response;
    };
  }
  const audio = new Set();
  if (embedded) {
    for (const key of ['AudioContext', 'webkitAudioContext']) {
      if (!window[key]) continue;
      window[key] = new Proxy(window[key], {
        construct(target, args, newTarget) {
          const context = Reflect.construct(target, args, newTarget);
          audio.add(context);
          return context;
        },
      });
    }
  }
  function unlockAudio() {
    for (const context of audio) {
      if (context.state === 'closed') audio.delete(context);
      else if (context.state !== 'running') context.resume().catch(() => {});
    }
  }
  function send(type, detail = {}) {
    if (embedded) window.parent.postMessage({channel: 'cartridge-club', type, ...detail}, location.origin);
  }
  window.clubGame = {
    embedded,
    unlockAudio,
    pendingDownloads:() => Promise.all(downloads),
    bindStorage(fs) {
      filesystem = fs;
      if (!embedded) return;
      const sync = fs.sync.bind(fs);
      // Godot can schedule autosave while the host is flushing on focus loss.
      // Queue both callers on the same mount instead of dropping either write.
      fs.sync = () => {
        // Calls made before a queued scan starts can use the same snapshot.
        // Writes made during a scan still schedule a subsequent IDBFS sync.
        if (!queuedSync) {
          queuedSync = lastSync = lastSync.catch(() => {}).then(async () => {
            queuedSync = undefined;
            const error = await sync();
            for (const notify of syncListeners) notify();
            return error;
          });
        }
        return queuedSync;
      };
    },
    async flush(onSync) {
      if (!filesystem?.is_persistent()) throw new Error('存档存储不可用');
      if (onSync) syncListeners.add(onSync);
      try {
        let write = filesystem.sync();
        for (;;) {
          const error = await write;
          if (error) throw error;
          if (write === lastSync) return;
          write = lastSync;
        }
      } finally { syncListeners.delete(onSync); }
    },
    progress(loaded, total) {
      if (complete || !(total > 0) || !(loaded > 0)) return;
      const percent = Math.min(100, Math.floor(loaded / total * 100));
      if (percent === lastPercent) return;
      lastPercent = percent;
      send('progress', {percent});
    },
    ready() {
      if (complete) return;
      complete = true;
      if (embedded && !filesystem?.is_persistent()) send('error', {message:'storage-unavailable'});
      else send('ready');
    },
    fail(message) {
      if (complete) return;
      complete = true;
      send('error', {message});
    },
  };
  if (embedded) {
    for (const event of ['pointerup', 'touchend', 'keydown']) {
      window.addEventListener(event, e => { if (e.isTrusted) unlockAudio(); }, {capture:true, passive:true});
    }
    window.addEventListener('error', event => {
      if (event.target instanceof HTMLScriptElement || event.error) {
        clubGame.fail(event.message || '游戏运行文件下载失败');
      }
    }, true);
    window.addEventListener('unhandledrejection', event => clubGame.fail(String(event.reason)));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && filesystem?.is_persistent()) clubGame.flush().catch(console.warn);
    });
    send('boot');
  }
}
