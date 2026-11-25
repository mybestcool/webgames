'use strict';
(async () => {
  if (!clubGame.embedded) return;
  const release = JSON.parse(document.getElementById('cartridge').textContent);
  const canvas = document.getElementById('canvas');
  const status = document.getElementById('status');
  const total = release.engine.compressedBytes + release.data.compressedBytes;
  let downloaded = 0;
  let worker;
  let displayScale;
  const pending = new Map();
  let sequence = 0;

  function fitCanvas() {
    const width = window.visualViewport?.width ?? innerWidth;
    const height = window.visualViewport?.height ?? innerHeight;
    const frameWidth = release.layout === 'portrait' ? Math.min(width, height * 9 / 16) : width;
    canvas.style.width = frameWidth + 'px';
    canvas.style.height = height + 'px';
    displayScale = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(frameWidth * displayScale);
    const pixelHeight = Math.round(height * displayScale);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  }

  function fallbackDecode(input, expectedBytes) {
    if (!worker) {
      worker = new Worker(release.decoder, {type: 'module'});
      worker.onmessage = ({data}) => {
        const job = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) job.reject(new Error(data.error));
        else job.resolve(data.output);
      };
      worker.onerror = () => {
        for (const job of pending.values()) job.reject(new Error('离线解码器启动失败'));
        pending.clear();
      };
    }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, {resolve, reject});
      worker.postMessage({id, input, expectedBytes}, [input]);
    });
  }

  async function readPart(part) {
    const response = await fetch(part.path);
    if (!response.ok) throw new Error('下载失败 · ' + response.status);
    const bytes = new Uint8Array(part.bytes);
    const reader = response.body.getReader();
    let offset = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes.set(value, offset);
      offset += value.length;
      downloaded += value.length;
      clubGame.progress(downloaded, total);
    }
    if (offset !== part.bytes) throw new Error('卡带下载不完整');
    if (crypto.subtle) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== part.sha256) throw new Error('卡带校验失败');
    }
    return bytes;
  }

  async function unpack(file) {
    const parts = await Promise.all(file.parts.map(readPart));
    let native;
    try { native = new DecompressionStream('brotli'); } catch { /* Older browsers use the bundled worker. */ }
    if (native) {
      const output = await new Response(new Blob(parts).stream().pipeThrough(native)).arrayBuffer();
      if (output.byteLength !== file.bytes) throw new Error('卡带解压长度错误');
      return output;
    }
    const input = parts.length === 1 ? parts[0].buffer : await new Blob(parts).arrayBuffer();
    return fallbackDecode(input, file.bytes);
  }

  function loadEngine() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.onload = resolve;
      script.onerror = () => reject(new Error('引擎脚本下载失败'));
      script.src = release.script;
      document.head.append(script);
    });
  }

  try {
    fitCanvas();
    addEventListener('resize', fitCanvas);
    window.visualViewport?.addEventListener('resize', fitCanvas);
    // Embedded canvases can change display density without a resize or media query event.
    setInterval(() => {
      if (!document.hidden && (window.devicePixelRatio || 1) !== displayScale) fitCanvas();
    }, 1000);
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    // Start all network requests together. Compile the engine and mount its
    // IndexedDB while the project data is still downloading or decompressing.
    const wasm = unpack(release.engine);
    const engine = Promise.all([loadEngine(), wasm]).then(async ([, binary]) => {
      if (!Engine.isWebGLAvailable(2)) throw new Error('浏览器未开启 WebGL 2');
      const instance = new Engine({canvas, canvasResizePolicy: 0, executable: 'game'});
      const response = new Response(binary, {headers: {'Content-Type': 'application/wasm'}});
      await Engine.load('game', binary.byteLength, response);
      await instance.init('game');
      return instance;
    });
    const [instance, data] = await Promise.all([engine, unpack(release.data)]);
    await instance.preloadFile(data, 'game.pck');
    worker?.terminate();
    const ready = release.readyEvent ? new Promise((resolve, reject) => {
      addEventListener(release.readyEvent, resolve, {once: true});
      addEventListener(release.readyEvent.replace(/-ready$/, '-load-error'), () => reject(new Error('游戏资源加载失败')), {once: true});
    }) : Promise.resolve();
    await Promise.all([instance.start({args: ['--main-pack', 'game.pck']}), ready]);
    clubGame.ready();
  } catch (error) {
    worker?.terminate();
    status.textContent = String(error);
    clubGame.fail(status.textContent);
  }
})();
