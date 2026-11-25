import {games} from './games.js';
import {prepareGame, protectStorage, byteLabel, controlsPage, appDisplay} from './pwa.js';

const machine = document.querySelector('.machine');
const lobby = document.querySelector('#club-lobby');
const session = machine.querySelector('.session');
const curtain = machine.querySelector('.curtain');
const bay = document.querySelector('#bay');
const title = document.querySelector('#state-title');
const status = document.querySelector('#status');
const hint = document.querySelector('#hint');
const meter = document.querySelector('#meter');
const progress = meter.querySelector('progress');
const percentLabel = document.querySelector('#percent');
const proceed = document.querySelector('#proceed');
const screenButton = document.querySelector('#toggle-fullscreen');
const screenStatus = document.querySelector('#screen-status');
const controls = document.querySelector('.game-controls');
const openTab = document.querySelector('#open-game-tab');
const leave = document.querySelector('#leave');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const touchScreen = matchMedia('(any-pointer: coarse)');
const fullscreenDisplay = matchMedia('(display-mode: fullscreen)');
let game, frame, state = 'shelf', generation = 0;
let requestedFullscreen = false;
let requestedLandscape = false;
let workerReportsProgress = false;
let checkAfterLoad = false;
let recoveryTimer;
function watchLoading() {
  clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => {
    if (state !== 'loading') return;
    hint.hidden = false;
    hint.textContent = '载入时间较长，可以继续等待或重新载入。';
    action('重新载入', () => launch(game));
    openTab.hidden = window.top === window;
  }, 12000);
}
let unlockSaves, syncFailed = false;

function warnBeforeUnload(event) {
  event.preventDefault();
  event.returnValue = true;
}

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function requestLandscape() {
  if (machine.dataset.layout !== 'landscape' || !touchScreen.matches || !screen.orientation?.lock) return;
  requestedLandscape = true;
  screen.orientation.lock('landscape').catch(() => { /* A portrait viewport uses the rotated game surface. */ });
}
function releaseLandscape() {
  if (!requestedLandscape) return;
  requestedLandscape = false;
  try { screen.orientation.unlock(); } catch { /* The browser may already have released its lock. */ }
}
let screenNoticeTimer;
function updateScreenButton() {
  const full = Boolean(fullscreenElement());
  const canEnter = (document.fullscreenEnabled && document.documentElement.requestFullscreen) ||
    (document.webkitFullscreenEnabled && document.documentElement.webkitRequestFullscreen);
  screenButton.hidden = appDisplay.matches || Boolean(navigator.standalone) ||
    (!full && (fullscreenDisplay.matches || !canEnter));
  const label = full ? '切换为窗口' : '全屏游玩';
  screenButton.title = label;
  screenButton.setAttribute('aria-label', label);
  screenButton.setAttribute('aria-pressed', String(full));
  if (!full) requestedFullscreen = false;
}
function screenNotice(text) {
  clearTimeout(screenNoticeTimer);
  screenStatus.textContent = text;
  screenStatus.hidden = false;
  screenNoticeTimer = setTimeout(() => { screenStatus.hidden = true; }, 3400);
}
screenButton.addEventListener('click', async () => {
  if (state !== 'playing' || screenButton.hidden) return;
  frame.contentWindow.clubGame?.unlockAudio?.();
  const run = generation;
  const root = document.documentElement;
  try {
    if (fullscreenElement()) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
      await (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      requestedFullscreen = true;
      if (run !== generation) exitFullscreen();
      else requestLandscape();
    } else {
      screenNotice('当前窗口不支持切换全屏。');
    }
  } catch { screenNotice('浏览器未允许切换全屏。'); }
  updateScreenButton();
  if (run === generation) frame?.contentWindow.focus();
});
document.addEventListener('fullscreenchange', updateScreenButton);
document.addEventListener('webkitfullscreenchange', updateScreenButton);
appDisplay.addEventListener('change', updateScreenButton);
fullscreenDisplay.addEventListener('change', updateScreenButton);
function exitFullscreen() {
  if (!requestedFullscreen || !fullscreenElement()) return;
  requestedFullscreen = false;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  Promise.resolve(exit.call(document)).catch(() => {});
}
function message(heading, detail, note = '') {
  if (title.textContent !== heading) title.textContent = heading;
  if (status.textContent !== detail) status.textContent = detail;
  hint.textContent = note;
  hint.hidden = !note;
  meter.hidden = state !== 'loading';
  proceed.hidden = true;
  openTab.hidden = true;
}
function action(label, handle) {
  proceed.textContent = label;
  proceed.hidden = false;
  proceed.onclick = handle;
}
function showLoading(detail, value = null, note = '') {
  message('正在载入卡带', detail, note);
  meter.classList.toggle('indeterminate', value === null);
  if (value === null) {
    progress.removeAttribute('value');
    percentLabel.textContent = '';
  } else {
    progress.value = value;
    percentLabel.textContent = value + '%';
  }
}
function reset() {
  window.removeEventListener('beforeunload', warnBeforeUnload);
  clearTimeout(recoveryTimer);
  releaseLandscape();
  delete machine.dataset.layout;
  generation++;
  frame?.remove();
  frame = null;
  unlockSaves?.();
  unlockSaves = undefined;
  workerReportsProgress = false;
  checkAfterLoad = false;
  syncFailed = false;
  proceed.disabled = false;
  controls.style.removeProperty('left');
  controls.style.removeProperty('top');
  screenStatus.hidden = true;
  updateScreenButton();
  machine.classList.remove('entering');
  if (leave.open) leave.close();
  session.inert = true;
  curtain.hidden = false;
}
function shelf() {
  reset();
  state = 'shelf';
  machine.hidden = true;
  lobby.hidden = false;
  document.body.classList.remove('player');
  delete document.body.dataset.game;
  document.title = '放学卡带社';
  exitFullscreen();
  const selected = games.find(item => item.id === history.state?.selected);
  if (selected) {
    window.scrollTo(0, history.state.scrollY || 0);
    lobby.querySelector('[data-game="' + selected.id + '"]')?.focus({preventScroll:true});
  }
  window.dispatchEvent(new Event('club-shelf'));
}
function navigateBack() {
  if (history.state?.clubEntry) history.back();
  else { history.replaceState({selected:game?.id}, '', './#shelf'); shelf(); }
}

// Give Godot a frame to handle focus loss, then commit its existing save files.
async function writeSave() {
  state = 'closing';
  let timeout, renew, active = true;
  const stalled = new Promise((_, reject) => {
    renew = () => {
      if (!active) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => reject(new Error('等待存档写入超时')), 45000);
    };
  });
  try {
    machine.querySelector('.float-back').focus({preventScroll:true});
    session.inert = true;
    clearTimeout(screenNoticeTimer);
    screenStatus.textContent = '正在同步本地存档…';
    screenStatus.hidden = false;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    renew();
    await Promise.race([frame.contentWindow.clubGame.flush(renew), stalled]);
    return true;
  } catch (error) {
    console.warn('本地存档写入失败', error);
    state = 'playing';
    session.inert = false;
    syncFailed = true;
    document.querySelector('#leave-title').textContent = '本地存档同步失败';
    document.querySelector('#leave-note').textContent = '本次进度可能尚未写入设备。可以留在游戏中检查存档后重试。';
    document.querySelector('#exit').textContent = '仍然离开';
    if (!leave.open) leave.showModal();
    return false;
  } finally {
    active = false;
    clearTimeout(timeout);
    screenStatus.hidden = true;
  }
}
function fail(detail) {
  clearTimeout(recoveryTimer);
  releaseLandscape();
  state = 'error';
  message('卡带载入失败', detail);
  action('重新载入', () => launch(game));
  openTab.hidden = window.top === window;
  frame?.remove();
  frame = null;
  unlockSaves?.();
  unlockSaves = undefined;
}
async function play() {
  if (state !== 'ready') return;
  frame.contentWindow.clubGame?.unlockAudio?.();
  state = 'entering';
  const run = generation;
  machine.classList.add('entering');
  if (!reduced.matches) {
    const animations = machine.querySelector('.power-on').getAnimations();
    await Promise.allSettled(animations.map(animation => animation.finished));
  }
  if (run !== generation) return;
  machine.classList.remove('entering');
  if (state === 'entering') state = 'playing';
  curtain.hidden = true;
  session.inert = state === 'closing';
  if (!leave.open && state === 'playing') {
    frame.focus();
    frame.contentDocument?.querySelector('canvas')?.focus({preventScroll:true});
  }
}
async function launch(choice) {
  reset();
  const run = generation;
  game = choice;
  machine.hidden = false;
  document.body.classList.add('player');
  lobby.hidden = true;
  if (!game) {
    state = 'error';
    document.querySelector('.game-name').textContent = '';
    document.querySelector('#edition').textContent = '';
    document.querySelector('#tune').removeAttribute('src');
    message('找不到这盘卡带', '请返回卡带架重新选择。');
    action('返回卡带架', navigateBack);
    return;
  }
  state = 'loading';
  window.addEventListener('beforeunload', warnBeforeUnload);
  machine.dataset.layout = game.orientation === '横屏' ? 'landscape' : 'portrait';
  requestLandscape();
  openTab.href = './?game=' + game.id;
  document.body.dataset.game = game.id;
  document.title = game.title + ' · 放学卡带社';
  document.querySelector('.game-name').textContent = game.title;
  document.querySelector('#edition').textContent = game.subtitle + '　/　' + game.orientation;
  document.querySelector('#tune').src = 'assets/' + game.id + '-tv.webp';
  showLoading('正在打开卡带…');
  watchLoading();
  // Both exports sync the same IndexedDB mount. Overlapping writers could
  // reconcile an old snapshot over a newer save from another tab.
  if (navigator.locks) {
    const acquired = await new Promise((resolve, reject) => {
      navigator.locks.request('cartridge-club:/userfs', {ifAvailable:true}, lock => {
        if (!lock || generation !== run) { resolve(false); return; }
        const held = new Promise(release => { unlockSaves = release; });
        resolve(true);
        return held;
      }).catch(reject);
    }).catch(() => false);
    if (generation !== run) return;
    if (!acquired) { fail('另一窗口正在使用本地存档。请先返回那边的卡带架，再重试。'); return; }
  }
  try {
    const saved = await prepareGame(game.id, p => {
      if (generation !== run || state !== 'loading') return;
      workerReportsProgress = true;
      if (!frame && p.startVersion && controlsPage()) {
        mountGame(run, p.startVersion);
      }
      watchLoading();
      if (p.percent >= 100) showLoading('正在启动游戏引擎…');
      else showLoading('正在准备卡带资源', p.percent,
        Number.isFinite(p.total) ? byteLabel(p.loaded) + ' / ' + byteLabel(p.total) : '');
    }, 'play');
    if (generation !== run || state === 'error') return;
    checkAfterLoad = Boolean(saved.checkAfterLoad);
    if (saved.label) document.querySelector('#edition').textContent += '　v' + saved.label;
    if (!frame) mountGame(run, controlsPage() ? saved.version : null);
    if (state === 'loading') showLoading(workerReportsProgress ? '正在启动游戏引擎…' : '正在读取卡带资源…');
    window.dispatchEvent(new Event('club-versions'));
  } catch (error) {
    if (generation !== run || state !== 'loading') return;
    if (!navigator.onLine) { fail('这盘卡带尚未完整缓存，请联网后重试。'); return; }
    checkAfterLoad = true;
    workerReportsProgress = false;
    frame?.remove();
    mountGame(run, null);
    showLoading('正在读取卡带资源…');
  }
}
function mountGame(run, version) {
  watchLoading();
  frame = document.createElement('iframe');
  frame.title = game.title + '游戏画面';
  frame.allow = 'autoplay; fullscreen';
  const suffix = version ? '~' + version : '';
  frame.src = 'games/' + game.id + suffix + '/index.html?club';
  frame.addEventListener('load', event => {
    if (event.currentTarget !== frame || run !== generation || state !== 'loading') return;
    try { if (frame.contentWindow.clubGame?.embedded) return; } catch { /* Login redirect or network error. */ }
    fail('未能打开游戏入口，请检查连接后重试。');
  }, {once:true});
  bay.replaceChildren(frame);
}
export function openGame(choice) {
  if (state !== 'shelf') return;
  history.replaceState({...history.state, scrollY:window.scrollY}, '');
  history.pushState({clubEntry:true}, '', './?game=' + choice.id);
  launch(choice);
}
export function restoreRoute() {
  const params = new URLSearchParams(location.search);
  if (params.has('game')) {
    const choice = games.find(item => item.id === params.get('game'));
    if (choice && !history.state?.clubEntry) {
      // Direct game links need the same in-app Back destination as a shelf launch.
      const gameUrl = location.href;
      history.replaceState({selected:choice.id}, '', './#shelf');
      history.pushState({clubEntry:true}, '', gameUrl);
    }
    launch(choice);
  } else if (state !== 'shelf') shelf();
}
window.addEventListener('message', event => {
  if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin ||
      event.data?.channel !== 'cartridge-club' || state !== 'loading') return;
  const data = event.data;
  watchLoading();
  if (data.type === 'progress' && Number.isFinite(data.percent)) {
    // During a first install the worker measures the whole cartridge. A warm
    // or direct launch gets its byte counts from the shared game loader.
    if (workerReportsProgress) return;
    if (data.percent < 100) showLoading('正在读取卡带资源…', data.percent);
    else showLoading('正在启动游戏引擎…');
  } else if (data.type === 'ready') {
    clearTimeout(recoveryTimer);
    showLoading('游戏已就绪', 100);
    state = 'ready';
    play();
    if (checkAfterLoad && navigator.onLine) {
      checkAfterLoad = false;
      const id = game.id;
      Promise.resolve(frame.contentWindow.clubGame?.pendingDownloads?.())
        .then(() => prepareGame(id, undefined, 'update')).then(() => {
        window.dispatchEvent(new Event('club-versions'));
      }).catch(() => { /* The running cartridge stays pinned to its complete release. */ });
    }
  } else if (data.type === 'error') {
    const reason = /WebGL|missing.*feature/i.test(data.message) ? '当前浏览器缺少 WebGL 2 支持。' : '游戏资源暂时无法打开，请检查网络后重试。';
    fail(data.message === 'storage-unavailable' ? '浏览器未允许本地存档。请启用站点存储后重试。' : reason);
  }
});
function requestExit() {
  if (!game) { navigateBack(); return; }
  if (leave.open || state === 'closing' || state === 'leaving') return;
  syncFailed = false;
  document.querySelector('#leave-title').textContent = '退出《' + game.title + '》？';
  document.querySelector('#leave-note').textContent = game.exitNote || '退出后将返回卡带架。';
  document.querySelector('#exit').textContent = '返回卡带架';
  leave.showModal();
}
document.querySelectorAll('[data-back]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  requestExit();
}));
function stayInGame() {
  leave.close();
  if (state === 'playing') frame?.contentWindow.focus();
}
document.querySelector('#stay').onclick = stayInGame;
leave.addEventListener('cancel', event => { event.preventDefault(); stayInGame(); });
document.querySelector('#exit').onclick = async () => {
  if (!leave.open) return;
  leave.close();
  if (!syncFailed && ['entering','playing'].includes(state) && !await writeSave()) return;
  generation++;
  state = 'leaving';
  window.removeEventListener('beforeunload', warnBeforeUnload);
  navigateBack();
  protectStorage();
};
window.addEventListener('popstate', () => {
  if (game && state !== 'shelf' && state !== 'leaving') {
    if (new URLSearchParams(location.search).get('game') !== game.id) {
      history.pushState({clubEntry:true}, '', './?game=' + game.id);
      requestExit();
    }
    return;
  }
  restoreRoute();
});
window.addEventListener('pageshow', event => { if (event.persisted && state === 'shelf') restoreRoute(); });

// Capture on the pressed button so a stationary pointer keeps its native click.
let drag, moved = false;
controls.addEventListener('pointerdown', event => {
  const button = event.target.closest('button');
  if (!button || !event.isPrimary || event.button !== 0) return;
  const rotated = getComputedStyle(machine).transform !== 'none';
  drag = {id:event.pointerId, x:event.clientX, y:event.clientY, left:controls.offsetLeft, top:controls.offsetTop, rotated};
  moved = false;
  button.setPointerCapture(event.pointerId);
});
controls.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.id) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!moved && Math.hypot(dx, dy) < 7) return;
  moved = true;
  const left = drag.left + (drag.rotated ? dy : dx);
  const top = drag.top + (drag.rotated ? -dx : dy);
  controls.style.left = Math.max(0, Math.min(session.clientWidth - controls.offsetWidth, left)) + 'px';
  controls.style.top = Math.max(0, Math.min(session.clientHeight - controls.offsetHeight, top)) + 'px';
});
controls.addEventListener('lostpointercapture', () => { drag = null; });
controls.addEventListener('click', event => {
  if (moved && event.detail) {
    moved = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
window.addEventListener('resize', () => {
  controls.style.removeProperty('left');
  controls.style.removeProperty('top');
});
