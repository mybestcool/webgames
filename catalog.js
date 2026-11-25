import {games} from './games.js';
import {openGame, restoreRoute} from './player.js';
import {initOfflineTools} from './pwa.js';

const rows = document.querySelector('#rows');
document.querySelector('#count').textContent = String(games.length).padStart(2, '0') + ' 盘';
for (const game of games) {
  const row = document.querySelector('#game-row').content.firstElementChild.cloneNode(true);
  row.href = './?game=' + game.id;
  row.dataset.game = game.id;
  row.setAttribute('aria-label', '开玩 ' + game.title + '，' + game.orientation + '，' + game.genre);
  row.querySelector('.cartridge').src = 'assets/' + game.id + '-cart.webp';
  row.querySelector('.game-title').textContent = game.title;
  row.querySelector('.subtitle').append(game.subtitle);
  const genre = document.createElement('span');
  genre.className = 'desktop-genre';
  genre.textContent = '　/　' + game.genre;
  row.querySelector('.subtitle').append(genre);
  row.querySelector('.direction').textContent = game.orientation;
  const mobileGenre = document.createElement('span');
  mobileGenre.className = 'mobile-genre';
  mobileGenre.textContent = ' · ' + game.genre;
  row.querySelector('.direction').append(mobileGenre);
  row.querySelector('.description').textContent = game.description;
  row.addEventListener('click', event => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.replaceState({...history.state, selected: game.id}, '');
    openGame(game);
  });
  rows.append(row);
}
function restoreFocus() {
  const selected = history.state?.selected;
  if (!document.querySelector('#club-lobby').hidden && games.some(game => game.id === selected)) {
    rows.querySelector('[data-game="' + selected + '"]').focus({preventScroll:true});
  }
}
window.addEventListener('pageshow', restoreFocus);
document.querySelector('.jump').addEventListener('click', () => {
  document.querySelector('#shelf-title').focus({preventScroll:true});
});

restoreRoute();
initOfflineTools();
