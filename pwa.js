import {games} from './games.js';

import appVersion from './app-version.js';

let serviceWorker;
try { if (window.isSecureContext) serviceWorker = navigator.serviceWorker; }
catch { /* Restricted frames can throw when accessing the API. */ }
const supported = Boolean(serviceWorker);
export const controlsPage = () => Boolean(serviceWorker?.controller);
let registration;

function register() {
  if (!supported) return Promise.reject(new Error('当前浏览器不支持离线缓存'));
  registration ??= serviceWorker.register('./sw.js', {updateViaCache:'none'}).catch(error => {
    registration = undefined;
    throw error;
  });
  return registration;
}
async function activeWorker() {
  const sw = serviceWorker;
  // An installed PWA can already have a usable controller while an offline registration fails.
  if (sw?.controller && sw.controller.state !== 'redundant') return sw.controller;
  const reg = await register();
  if (reg.active) return reg.active;
  const worker = reg.installing || reg.waiting;
  if (!worker) throw new Error('离线服务未就绪');
  return new Promise((resolve, reject) => {
    function check() {
      if (!['activated','redundant'].includes(worker.state)) return;
      worker.removeEventListener('statechange', check);
      if (worker.state === 'activated') resolve(worker);
      else reject(new Error('未能缓存大厅，请联网重试'));
    }
    worker.addEventListener('statechange', check);
    check();
  });
}
async function ask(data, update, retry = true) {
  const playingOnline = data.mode === 'play' && navigator.onLine;
  let startupTimer;
  let worker;
  try {
    worker = await (playingOnline ? Promise.race([activeWorker(), new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(new Error('离线服务稍后就绪')), 1500);
    })]) : activeWorker());
    if (playingOnline && !controlsPage()) throw new Error('离线服务尚未接管页面');
  } finally { clearTimeout(startupTimer); }
  const reply = new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let timer;
    function finish(callback, result) {
      clearTimeout(timer);
      worker.removeEventListener('statechange', stateChanged);
      channel.port1.close();
      callback(result);
    }
    function renew(timeout = 65000) {
      clearTimeout(timer);
      timer = setTimeout(() => finish(reject, new Error('下载长时间无响应，请重试')), timeout);
    }
    function stateChanged() {
      if (worker.state === 'redundant') finish(reject, new Error('离线服务已更新'));
    }
    worker.addEventListener('statechange', stateChanged);
    renew(playingOnline ? 6500 : 65000);
    channel.port1.onmessage = ({data}) => {
      if (data.type === 'progress') { renew(); update?.(data); return; }
      if (data.type === 'error') finish(reject, new Error(data.message));
      else finish(resolve, data);
    };
    try { worker.postMessage(data, [channel.port2]); }
    catch (error) { finish(reject, error); }
  });
  try { return await reply; }
  catch (error) {
    if (retry && worker.state === 'redundant') return ask(data, update, false);
    throw error;
  }
}
export const prepareGame = (id, update, mode = 'launch') => ask({type:'prepare', id, mode}, update);
export const byteLabel = value => (value / 1048576).toFixed(1) + ' MiB';
export function protectStorage() {
  navigator.storage?.persist?.().catch(() => {});
}
function initInstall() {
  const panel = document.querySelector('#install-panel');
  const button = document.querySelector('#install-app');
  const help = document.querySelector('#install-help');
  const standalone = matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)');
  const fullscreen = matchMedia('(display-mode: fullscreen)');
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Version\/(\d+).*Safari\//.exec(navigator.userAgent);
  const appleGuide = ios ? '在 Safari 中点「共享 → 添加到主屏幕」，再点「添加」。' :
    safari && Number(safari[1]) >= 17 ? '在 Safari 中选「文件 → 添加到程序坞」。' : '';
  const storageKey = 'cartridge-club:installed';
  let installed = false, checked = !navigator.getInstalledRelatedApps;
  let canGuide = Boolean(appleGuide) || /Android.*Firefox\//.test(navigator.userAgent), installEvent;
  try { installed = localStorage.getItem(storageKey) === 'yes'; } catch { /* Storage is optional. */ }

  function remember(value) {
    installed = value;
    try {
      if (value) localStorage.setItem(storageKey, 'yes');
      else localStorage.removeItem(storageKey);
    } catch { /* Display mode still works without storage. */ }
  }
  function render() {
    if (standalone.matches || navigator.standalone) remember(true);
    panel.hidden = installed || fullscreen.matches || !checked || !(installEvent || canGuide);
    if (panel.hidden) help.hidden = true;
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    // A fresh native offer also restores installation after an uninstall.
    remember(false);
    installEvent = event;
    checked = true;
    render();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    remember(true);
    render();
  });
  standalone.addEventListener('change', render);
  fullscreen.addEventListener('change', render);
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) {
      installed = event.newValue === 'yes';
      render();
    }
  });
  window.addEventListener('pageshow', render);
  if (navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps().then(apps => {
      // Our manifest lists only the club itself as a related web app.
      if (apps.some(app => app.platform === 'webapp')) remember(true);
      else if (/Chrome\/|Edg\//.test(navigator.userAgent)) canGuide = true;
    }).catch(() => {}).finally(() => { checked = true; render(); });
  }
  button.onclick = async () => {
    const offer = installEvent;
    if (offer) {
      installEvent = null;
      button.disabled = true;
      try {
        await offer.prompt();
        await offer.userChoice;
        return;
      } catch { /* Offer menu instructions if the native prompt expired. */ }
      finally { button.disabled = false; render(); }
    }
    help.querySelector('p').textContent = appleGuide || '打开浏览器菜单，选择「安装应用」或「添加到主屏幕」。';
    help.hidden = false;
  };
  document.querySelector('#already-installed').onclick = () => { remember(true); render(); };
  render();
}
export function initOfflineTools() {
  const tools = document.querySelector('.offline-tools');
  const label = document.querySelector('#offline-status');
  const cacheAll = document.querySelector('#cache-all');
  tools.hidden = !supported;
  if (!supported) return;
  initInstall();
  const meter = document.querySelector('#cache-progress');
  const detail = document.querySelector('#cache-detail');
  const shellLabel = document.querySelector('#club-version');
  shellLabel.textContent = '大厅 v' + appVersion.label;
  shellLabel.title = '构建 ' + appVersion.version;
  let busy = false, pendingReload = false, checking = false, lastCheck = 0;
  function applyUpdate() {
    if (pendingReload && !busy && !document.querySelector('#club-lobby').hidden) location.reload();
  }
  async function refresh() {
    try {
      const {ready, versions, shell} = await ask({type:'status'});
      if (shell && shell.version !== appVersion.version) { pendingReload = true; applyUpdate(); }
      for (const game of games) {
        const version = versions?.[game.id];
        if (!version) continue;
        const badge = document.querySelector('.game-row[data-game="' + game.id + '"] .game-version');
        badge.textContent = version.label ? 'v' + version.label : version.version.slice(0, 7);
        badge.title = '构建 ' + version.version;
      }
      if (!busy) {
        label.textContent = '离线可玩 ' + ready.length + ' / ' + games.length + ' 盘';
        cacheAll.hidden = ready.length === games.length;
      }
    } catch (err) { if (!busy) label.textContent = err.message; }
  }
  async function checkUpdate() {
    if (checking || !navigator.onLine || document.hidden || Date.now() - lastCheck < 15000) return;
    checking = true;
    lastCheck = Date.now();
    try { await (await register()).update(); }
    catch { /* Keep the installed release usable without a connection. */ }
    finally { checking = false; }
  }
  cacheAll.onclick = async () => {
    if (busy) return;
    busy = true;
    cacheAll.disabled = true;
    meter.hidden = detail.hidden = false;
    meter.value = 0;
    label.textContent = '正在检查卡带';
    detail.textContent = '';
    protectStorage();
    try {
      const {ready, sizes} = await ask({type:'status'});
      const missing = games.filter(game => !ready.includes(game.id));
      let total = missing.reduce((n, g) => n + (sizes?.[g.id] || 0), 0);
      let done = 0;
      for (const game of missing) {
        label.textContent = '正在缓存《' + game.title + '》';
        let size = sizes?.[game.id] || 0;
        await prepareGame(game.id, p => {
          if (!Number.isFinite(p.loaded)) { detail.textContent = p.percent + '%'; return; }
          total += p.total - size;
          size = p.total;
          meter.value = Math.min(99, (done + p.loaded) * 100 / total);
          detail.textContent = Math.floor(meter.value) + '% · ' + byteLabel(done + p.loaded) + ' / ' + byteLabel(total);
        }, 'missing');
        done += size;
      }
      meter.value = 100;
      busy = false;
      await refresh();
    } catch (err) {
      label.textContent = '缓存未完成，' + err.message;
    } finally {
      busy = false;
      cacheAll.disabled = false;
      meter.hidden = detail.hidden = true;
      applyUpdate();
    }
  };
  serviceWorker.addEventListener('controllerchange', refresh);
  window.addEventListener('club-versions', refresh);
  window.addEventListener('club-shelf', () => { applyUpdate(); refresh(); checkUpdate(); });
  window.addEventListener('online', checkUpdate);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkUpdate(); refresh(); } });
  window.setInterval(checkUpdate, 60000);
  refresh();
  checkUpdate();
}
