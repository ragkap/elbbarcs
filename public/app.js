'use strict';

// --- Constants (match server) ---
const BOARD_SIZE = 15;
const TILE_VALUES = {
  A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,N:1,
  O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10,'_':0
};

// --- App state ---
const state = {
  socket: null,
  code: null,
  you: null,            // 0 or 1
  myName: localStorage.getItem('elbbarcs:name') || '',
  rack: [],             // array of letters (server-authoritative)
  board: null,          // 15x15 grid of {letter, blank} or null
  scores: [0, 0],
  players: [],
  turn: 0,
  bagCount: 100,
  premium: null,
  over: false,
  winner: null,
  // local placement state for current pending move
  pending: [],          // [{rackIndex, row, col, letter, blank}]
  history: []
};

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const screens = {
  lobby: $('#lobby'),
  waiting: $('#waiting'),
  game: $('#game')
};
function showScreen(name) {
  for (const k of Object.keys(screens)) screens[k].classList.toggle('active', k === name);
}

const boardEl = $('#board');
const rackEl = $('#rack');
const messageEl = $('#message');
const turnEl = $('#turn-indicator');
const bagEl = $('#bag-count');

// --- Lobby logic ---
$('#name-input').value = state.myName;
// Pre-fill room code from ?room= query param, and auto-join if we already have a saved name
const autoJoinRoom = (() => {
  const params = new URLSearchParams(location.search);
  const r = params.get('room');
  if (!r) return null;
  const code = r.toUpperCase().slice(0, 4);
  $('#code-input').value = code;
  return code;
})();
// When arriving via a share link, hide the lobby card — the user came to join one specific room,
// so the create/join form would just be noise. Show a minimal connecting state instead.
if (autoJoinRoom) {
  document.body.classList.add('autojoin-mode');
}
$('#create-btn').addEventListener('click', () => {
  const name = $('#name-input').value.trim() || 'Player 1';
  saveName(name);
  state.socket.emit('create', { name }, (res) => {
    if (!res.ok) return toast(res.reason, true);
    state.code = res.code; state.you = res.you;
    enterWaiting();
  });
});
$('#join-btn').addEventListener('click', () => {
  const name = $('#name-input').value.trim() || 'Player 2';
  const code = $('#code-input').value.trim().toUpperCase();
  if (!code) return toast('Enter a room code', true);
  saveName(name);
  state.socket.emit('join', { code, name }, (res) => {
    if (!res.ok) return toast(res.reason, true);
    state.code = res.code; state.you = res.you;
    enterWaiting();
  });
});
$('#start-btn').addEventListener('click', () => {
  state.socket.emit('start', {}, (res) => {
    if (!res.ok) return toast(res.reason, true);
  });
});
$('#leave-btn').addEventListener('click', () => location.reload());

function saveName(n) { state.myName = n; localStorage.setItem('elbbarcs:name', n); }

function enterWaiting() {
  $('#room-code').textContent = state.code;
  const isHost = state.you === 0;
  $('#share-row').style.display = isHost ? '' : 'none';
  $('#waiting-hint').textContent = isHost
    ? 'Share this code with your opponent.'
    : 'Waiting for the host to start the game…';
  $('#start-btn').style.display = isHost ? '' : 'none';
  showScreen('waiting');
  updateSoundToggleLabel();
}

function shareLink() {
  const url = new URL(window.location.href);
  url.search = '?room=' + encodeURIComponent(state.code);
  url.hash = '';
  return url.toString();
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through */ }
  // Fallback: hidden textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

$('#copy-link-btn').addEventListener('click', async () => {
  const link = shareLink();
  const ok = await copyText(link);
  Sounds.play(ok ? 'copy' : 'error');
  toast(ok ? 'Link copied' : 'Copy failed — link: ' + link, !ok);
});
$('#share-btn').addEventListener('click', async () => {
  const link = shareLink();
  const data = {
    title: 'elbbarcs',
    text: `Join my elbbarcs game — code ${state.code}`,
    url: link
  };
  if (navigator.share) {
    try { await navigator.share(data); Sounds.play('copy'); }
    catch (e) { /* user dismissed */ }
  } else {
    const ok = await copyText(link);
    Sounds.play(ok ? 'copy' : 'error');
    toast(ok ? 'Link copied (no native share)' : 'Copy failed', !ok);
  }
});

$('#sound-toggle').addEventListener('click', () => {
  Sounds.setEnabled(!Sounds.isEnabled());
  updateSoundToggleLabel();
  if (Sounds.isEnabled()) Sounds.play('copy');
});
function updateSoundToggleLabel() {
  const el = $('#sound-toggle');
  if (el) el.textContent = Sounds.isEnabled() ? '🔊 Sound: on' : '🔇 Sound: off';
}

let prevLobbyCount = 0;
let autoStarted = false;
function renderLobbyState(lobby) {
  if (lobby.players.length > prevLobbyCount && prevLobbyCount > 0) {
    Sounds.play('join');
  }
  prevLobbyCount = lobby.players.length;
  state.players = lobby.players;
  const list = $('#players-list');
  list.innerHTML = '';
  for (let i = 0; i < 2; i++) {
    const slot = document.createElement('div');
    slot.className = 'slot' + (lobby.players[i] ? '' : ' empty');
    if (lobby.players[i]) {
      slot.innerHTML = `<span>${escapeHtml(lobby.players[i].name)}</span><span>${i === lobby.you ? 'you' : ''}</span>`;
    } else {
      slot.textContent = 'Waiting for player…';
    }
    list.appendChild(slot);
  }
  $('#start-btn').disabled = lobby.players.length < 2 || lobby.you !== 0;

  // Auto-start: as soon as the room is full, the host kicks off the game.
  // Server then broadcasts 'state' to both clients, transitioning them into the game screen.
  if (lobby.players.length === 2 && lobby.you === 0 && !autoStarted) {
    autoStarted = true;
    state.socket.emit('start', {}, (res) => {
      if (!res.ok) {
        autoStarted = false;
        toast(res.reason || 'Could not start', true);
      }
    });
  }
}

// --- Game render ---
let prevTurn = null;
let prevHistoryLen = 0;
let prevOver = false;

function renderState(s) {
  const wasMine = prevTurn != null && prevTurn === s.you;
  const isMine = s.turn === s.you;
  const historyGrew = s.history.length > prevHistoryLen;
  const justEnded = s.over && !prevOver;

  state.board = s.board;
  state.rack = s.rack || [];
  state.scores = s.scores;
  state.players = s.players;
  state.turn = s.turn;
  state.bagCount = s.bagCount;
  state.premium = s.premium;
  state.over = s.over;
  state.winner = s.winner;
  state.history = s.history;
  state.you = s.you;
  state.pending = []; // a fresh state from server clears any local pending move

  // Scoreboard
  for (let i = 0; i < 2; i++) {
    const el = $('#p' + i + '-score');
    el.querySelector('.name').textContent = s.players[i] ? s.players[i].name : '—';
    el.querySelector('.val').textContent = s.scores[i];
    el.classList.toggle('active', s.turn === i && !s.over);
  }
  bagEl.textContent = s.bagCount;
  if (s.over) {
    showEndModal();
  } else {
    const isMine = s.turn === s.you;
    turnEl.textContent = isMine ? 'Your turn' : `${s.players[s.turn].name}'s turn`;
    turnEl.classList.toggle('your-turn', isMine);
  }

  if (historyGrew && s.lastMove) {
    if (s.lastMove.type === 'move') {
      const who = s.players[s.lastMove.player].name;
      toast(`${who} played ${s.lastMove.words[0].word} for ${s.lastMove.score}`);
      // Bingo if all 7 tiles placed
      if (s.lastMove.placements && s.lastMove.placements.length === 7) Sounds.play('bingo');
      else Sounds.play('play');
    } else if (s.lastMove.type === 'pass') {
      toast(`${s.players[s.lastMove.player].name} passed`);
      Sounds.play('pass');
    } else if (s.lastMove.type === 'exchange') {
      toast(`${s.players[s.lastMove.player].name} exchanged ${s.lastMove.count} tile${s.lastMove.count > 1 ? 's' : ''}`);
      Sounds.play('exchange');
    }
  }

  // Turn transitioned to me — gentle ding (but not on game-start initial state)
  if (!s.over && isMine && prevTurn != null && !wasMine) {
    Sounds.play('turn');
  }

  if (justEnded) Sounds.play('gameOver');

  prevTurn = s.turn;
  prevHistoryLen = s.history.length;
  prevOver = s.over;

  showScreen('game');
  renderBoard();
  renderRack();
}

function buildBoardOnce() {
  if (boardEl.dataset.built) return;
  boardEl.dataset.built = '1';
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      boardEl.appendChild(cell);
    }
  }
}

function premiumLabel(p) {
  switch (p) {
    case 'TW': return 'TRIPLE WORD';
    case 'DW': return 'DOUBLE WORD';
    case 'TL': return 'TRIPLE LETTER';
    case 'DL': return 'DOUBLE LETTER';
    default: return '';
  }
}

function renderBoard() {
  buildBoardOnce();
  const cells = boardEl.children;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = cells[r * BOARD_SIZE + c];
      cell.className = 'cell';
      cell.innerHTML = '';
      const prem = state.premium ? state.premium[r][c] : null;
      if (r === 7 && c === 7) cell.classList.add('center');
      else if (prem === 'TW') cell.classList.add('tw');
      else if (prem === 'DW') cell.classList.add('dw');
      else if (prem === 'TL') cell.classList.add('tl');
      else if (prem === 'DL') cell.classList.add('dl');
      else if (prem) cell.classList.add(prem.toLowerCase());

      const onBoard = state.board[r][c];
      if (onBoard) {
        cell.appendChild(makeTileEl(onBoard.letter, onBoard.blank, false));
      } else {
        const pending = state.pending.find(p => p.row === r && p.col === c);
        if (pending) {
          cell.appendChild(makeTileEl(pending.letter, pending.blank, true, true));
        } else if (prem && !(r === 7 && c === 7)) {
          const txt = document.createElement('div');
          txt.className = 'ptext';
          txt.textContent = prem;
          cell.appendChild(txt);
        }
      }
    }
  }
}

function makeTileEl(letter, blank, fresh, isPending = false) {
  const t = document.createElement('div');
  t.className = 'tile' + (fresh ? ' fresh' : '') + (blank ? ' blank' : '');
  t.textContent = letter;
  if (!blank) {
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = TILE_VALUES[letter] || 0;
    t.appendChild(pts);
  }
  if (isPending) t.dataset.pending = '1';
  return t;
}

function renderRack() {
  rackEl.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const slot = document.createElement('div');
    slot.className = 'rack-slot';
    slot.dataset.idx = i;
    const tile = state.rack[i];
    const usedHere = state.pending.find(p => p.rackIndex === i);
    if (tile && !usedHere) {
      const t = makeTileEl(tile === '_' ? ' ' : tile, tile === '_', false);
      t.dataset.rackIndex = i;
      slot.appendChild(t);
    } else {
      slot.classList.add('empty');
    }
    rackEl.appendChild(slot);
  }
}

// --- Drag and drop (pointer events; works on phone & desktop) ---
let drag = null;

function getRackTileAt(touch) {
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  if (!el) return null;
  const tile = el.closest('.tile[data-rack-index], .tile[data-pending]');
  return tile;
}

function startDrag(ev, sourceEl, source) {
  ev.preventDefault();
  const rect = sourceEl.getBoundingClientRect();
  drag = {
    source,           // {kind: 'rack', rackIndex} or {kind: 'board', row, col, rackIndex}
    sourceEl,
    pointerId: ev.pointerId,
    ghost: null,
    width: rect.width,
    height: rect.height,
    dropTarget: null
  };
  // Build ghost
  const g = sourceEl.cloneNode(true);
  g.classList.add('drag-ghost');
  g.style.width = rect.width + 'px';
  g.style.height = rect.height + 'px';
  g.style.left = ev.clientX + 'px';
  g.style.top = ev.clientY + 'px';
  document.body.appendChild(g);
  drag.ghost = g;
  sourceEl.style.opacity = '0.25';

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onEnd);
  document.addEventListener('pointercancel', onEnd);
}

function onMove(ev) {
  if (!drag) return;
  drag.ghost.style.left = ev.clientX + 'px';
  drag.ghost.style.top = ev.clientY + 'px';
  drag.ghost.style.display = 'none';
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  drag.ghost.style.display = '';
  // Identify drop target: a board cell or rack slot
  if (drag.dropTarget) drag.dropTarget.classList.remove('drop-target');
  drag.dropTarget = null;
  if (!under) return;
  const cell = under.closest('.cell');
  const slot = under.closest('.rack-slot');
  if (cell && !cell.querySelector('.tile')) {
    drag.dropTarget = cell;
    cell.classList.add('drop-target');
  } else if (slot && !slot.querySelector('.tile')) {
    drag.dropTarget = slot;
    slot.classList.add('drop-target');
  }
}

function onEnd(ev) {
  if (!drag) return;
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onEnd);
  document.removeEventListener('pointercancel', onEnd);
  const target = drag.dropTarget;
  const src = drag.source;
  if (target) target.classList.remove('drop-target');
  if (drag.ghost) drag.ghost.remove();
  if (drag.sourceEl) drag.sourceEl.style.opacity = '';
  const dragRef = drag;
  drag = null;

  if (!target) {
    // No valid drop. If dropped well outside the rack/board, recall to rack.
    const recall = !document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.rack, .board');
    if (recall && src.kind === 'board') {
      removePending(src.rackIndex);
      renderBoard(); renderRack();
    }
    return;
  }

  if (target.classList.contains('cell')) {
    const r = +target.dataset.r;
    const c = +target.dataset.c;
    placeTileFrom(src, r, c);
  } else if (target.classList.contains('rack-slot')) {
    const newIdx = +target.dataset.idx;
    if (src.kind === 'board') {
      removePending(src.rackIndex);
      // Rack swap not strictly meaningful (the rack array is server-side). Just re-render.
      renderBoard(); renderRack();
    }
    // Rack-to-rack rearrangement: visually-only nicety (skip here).
  }
}

function placeTileFrom(src, row, col) {
  // Cannot place on existing board tile
  if (state.board[row][col]) return;
  // Cannot place if not your turn
  if (state.turn !== state.you) { toast("It's not your turn", true); return; }

  if (src.kind === 'rack') {
    const rackIndex = src.rackIndex;
    const letter = state.rack[rackIndex];
    if (letter === '_') {
      promptBlank((chosen) => {
        addPending({ rackIndex, row, col, letter: chosen, blank: true });
      });
    } else {
      addPending({ rackIndex, row, col, letter: letter, blank: false });
    }
  } else if (src.kind === 'board') {
    // Move within pending
    const p = state.pending.find(pp => pp.rackIndex === src.rackIndex);
    if (!p) return;
    p.row = row; p.col = col;
    renderBoard(); renderRack();
  }
}

function addPending(p) {
  // Replace any existing pending with same rackIndex (shouldn't happen since rack slot empties)
  state.pending = state.pending.filter(pp => pp.rackIndex !== p.rackIndex);
  state.pending.push(p);
  Sounds.play('tilePlace');
  renderBoard(); renderRack();
}
function removePending(rackIndex) {
  state.pending = state.pending.filter(p => p.rackIndex !== rackIndex);
  Sounds.play('tileRecall');
}

// Tap on a placed pending tile to recall it
boardEl.addEventListener('click', (ev) => {
  const tileEl = ev.target.closest('.tile[data-pending]');
  if (!tileEl) return;
  const cell = tileEl.parentElement;
  const r = +cell.dataset.r, c = +cell.dataset.c;
  const p = state.pending.find(pp => pp.row === r && pp.col === c);
  if (p) { removePending(p.rackIndex); renderBoard(); renderRack(); }
});

// Pointerdown on rack tiles starts a drag
rackEl.addEventListener('pointerdown', (ev) => {
  const tile = ev.target.closest('.tile[data-rack-index]');
  if (!tile) return;
  if (state.turn !== state.you) return;
  const idx = +tile.dataset.rackIndex;
  startDrag(ev, tile, { kind: 'rack', rackIndex: idx });
});

// Pointerdown on a pending tile on the board moves it
boardEl.addEventListener('pointerdown', (ev) => {
  const tile = ev.target.closest('.tile[data-pending]');
  if (!tile) return;
  if (state.turn !== state.you) return;
  const cell = tile.parentElement;
  const r = +cell.dataset.r, c = +cell.dataset.c;
  const p = state.pending.find(pp => pp.row === r && pp.col === c);
  if (!p) return;
  startDrag(ev, tile, { kind: 'board', rackIndex: p.rackIndex, row: r, col: c });
});

// --- Action buttons ---
$('#recall-btn').addEventListener('click', () => {
  state.pending = []; renderBoard(); renderRack();
});
$('#shuffle-btn').addEventListener('click', () => {
  // Visual rack shuffle only (rack order is local cosmetic)
  const indices = state.rack.map((_, i) => i).filter(i => !state.pending.find(p => p.rackIndex === i));
  // Fisher-Yates on actual rack array
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = indices[i], b = indices[j];
    [state.rack[a], state.rack[b]] = [state.rack[b], state.rack[a]];
  }
  renderRack();
});
$('#play-btn').addEventListener('click', () => {
  if (state.turn !== state.you) return toast("Not your turn", true);
  if (state.pending.length === 0) return toast("Place tiles first", true);
  const placements = state.pending.map(p => ({
    row: p.row, col: p.col, letter: p.letter, rackIndex: p.rackIndex
  }));
  state.socket.emit('move', { placements }, (res) => {
    if (!res.ok) return toast(res.reason, true);
  });
});
$('#pass-btn').addEventListener('click', () => {
  if (state.turn !== state.you) return toast("Not your turn", true);
  if (!confirm('Pass your turn?')) return;
  state.socket.emit('pass', {}, (res) => {
    if (!res.ok) return toast(res.reason, true);
  });
});
$('#exchange-btn').addEventListener('click', () => {
  if (state.turn !== state.you) return toast("Not your turn", true);
  if (state.bagCount < 7) return toast("Bag has < 7 tiles", true);
  openExchangeModal();
});

// --- Blank picker ---
function promptBlank(cb) {
  const grid = $('#blank-letters');
  grid.innerHTML = '';
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i);
    const b = document.createElement('button');
    b.textContent = ch;
    b.addEventListener('click', () => { closeBlank(); cb(ch); });
    grid.appendChild(b);
  }
  $('#blank-modal').classList.remove('hidden');
}
function closeBlank() { $('#blank-modal').classList.add('hidden'); }
$('#blank-cancel').addEventListener('click', closeBlank);

// --- Exchange picker ---
function openExchangeModal() {
  const grid = $('#exchange-tiles');
  grid.innerHTML = '';
  const selected = new Set();
  state.rack.forEach((t, i) => {
    const cell = document.createElement('div');
    cell.className = 'ex-tile';
    cell.textContent = t === '_' ? ' ' : t;
    cell.addEventListener('click', () => {
      if (selected.has(i)) { selected.delete(i); cell.classList.remove('selected'); }
      else { selected.add(i); cell.classList.add('selected'); }
    });
    cell.dataset.idx = i;
    grid.appendChild(cell);
  });
  const modal = $('#exchange-modal');
  modal.classList.remove('hidden');
  $('#exchange-confirm').onclick = () => {
    if (selected.size === 0) { toast('Pick at least one tile', true); return; }
    state.socket.emit('exchange', { rackIndices: [...selected] }, (res) => {
      if (!res.ok) return toast(res.reason, true);
      modal.classList.add('hidden');
    });
  };
  $('#exchange-cancel').onclick = () => modal.classList.add('hidden');
}


// --- End modal ---
function showEndModal() {
  const modal = $('#end-modal');
  modal.classList.remove('hidden');
  let title = 'Game over';
  if (state.winner === -1) title = "It's a tie!";
  else if (state.winner != null) title = `${state.players[state.winner].name} wins!`;
  $('#end-title').textContent = title;
  $('#end-scores').innerHTML = state.scores
    .map((s, i) => `<div>${escapeHtml(state.players[i].name)}: <strong>${s}</strong></div>`)
    .join('');
  $('#end-rematch').onclick = () => location.reload();
}

// --- Toast ---
let toastTimer = null;
function toast(msg, isError = false) {
  messageEl.textContent = msg;
  messageEl.className = 'message show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => messageEl.classList.remove('show'), 2200);
  if (isError) Sounds.play('error');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

// --- Chat ---
const chatState = { unread: 0, open: false };

function onChatMessage(msg) {
  addChatMessage(msg);
  if (!chatState.open && msg.from !== state.players[state.you]?.name) {
    chatState.unread++;
    updateChatBadge();
    Sounds.play('chat');
  }
}

function addChatMessage(msg) {
  const ul = $('#chat-messages');
  const li = document.createElement('li');
  const mine = msg.from === state.players[state.you]?.name;
  if (mine) li.classList.add('mine');
  li.innerHTML = `<span class="who">${escapeHtml(msg.from)}</span>${escapeHtml(msg.text)}`;
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
}

function addSystemChat(text) {
  const ul = $('#chat-messages');
  const li = document.createElement('li');
  li.className = 'system';
  li.textContent = text;
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
}

function updateChatBadge() {
  const badge = $('#chat-badge');
  if (chatState.unread > 0) {
    badge.textContent = chatState.unread > 9 ? '9+' : String(chatState.unread);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function openChat() {
  chatState.open = true;
  chatState.unread = 0;
  updateChatBadge();
  $('#chat-panel').classList.remove('hidden');
  setTimeout(() => $('#chat-input').focus(), 30);
  // Scroll to bottom on open
  const ul = $('#chat-messages'); ul.scrollTop = ul.scrollHeight;
}
function closeChat() {
  chatState.open = false;
  $('#chat-panel').classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', wireChat);
// In case DOMContentLoaded already fired (script is at end of body, so it may have)
if (document.readyState !== 'loading') wireChat();
function wireChat() {
  const toggle = $('#chat-toggle');
  if (!toggle || toggle.dataset.wired) return;
  toggle.dataset.wired = '1';
  toggle.addEventListener('click', () => chatState.open ? closeChat() : openChat());
  $('#chat-close').addEventListener('click', closeChat);
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    state.socket.emit('chat', { text });
    input.value = '';
  });
}

// --- Peer status ---
function showPeerStatus(text, good) {
  const el = $('#peer-status');
  el.textContent = text;
  el.classList.remove('hidden');
  el.classList.toggle('good', !!good);
}
function hidePeerStatus() {
  $('#peer-status').classList.add('hidden');
}

// --- Definitions ---
let defHideTimer = null;
function showDefinitions(payload) {
  const wrap = $('#definitions');
  const body = $('#def-body');
  const titleText = $('#def-title-text');
  const mover = payload.playerName || 'Opponent';
  const isMine = state.players[state.you]?.name === mover;
  titleText.textContent = (isMine ? 'You' : mover) + ` played for ${payload.score}`;

  body.innerHTML = '';
  for (const w of payload.words) {
    const entry = document.createElement('div');
    entry.className = 'def-entry';
    if (w.def) {
      entry.innerHTML =
        `<span class="word">${escapeHtml(w.word)}</span>` +
        (w.def.partOfSpeech ? `<span class="pos">${escapeHtml(w.def.partOfSpeech)}</span>` : '') +
        `<span class="meaning">${escapeHtml(w.def.definition)}</span>` +
        (w.def.example ? `<span class="example">“${escapeHtml(w.def.example)}”</span>` : '');
    } else {
      entry.innerHTML =
        `<span class="word">${escapeHtml(w.word)}</span>` +
        `<span class="missing">No definition found (still a valid Scrabble word).</span>`;
    }
    body.appendChild(entry);
  }
  const attrib = document.createElement('div');
  attrib.className = 'def-attribution';
  attrib.textContent = 'definitions via dictionaryapi.dev';
  body.appendChild(attrib);

  wrap.classList.remove('hidden');
  clearTimeout(defHideTimer);
  // Auto-hide after 20s — long enough to read multiple word definitions, short enough
  // to not block the next play. The close (×) button is always available.
  defHideTimer = setTimeout(() => wrap.classList.add('hidden'), 20000);
}

function hideDefinitions() {
  clearTimeout(defHideTimer);
  $('#definitions').classList.add('hidden');
}

if (document.readyState !== 'loading') wireDefinitions();
else document.addEventListener('DOMContentLoaded', wireDefinitions);
function wireDefinitions() {
  const btn = $('#def-close');
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', hideDefinitions);
  }
}

function doJoin(code, name, onFail) {
  state.socket.emit('join', { code, name }, (res) => {
    if (!res.ok) {
      // If the game already started, try rejoining a vacant slot under this name.
      if (/already started|Room full/i.test(res.reason || '')) {
        state.socket.emit('rejoin', { code, name }, (res2) => {
          if (!res2.ok) {
            toast(res2.reason || res.reason, true);
            const status = $('#autojoin-status');
            if (status) status.textContent = (res2.reason || res.reason) + ' — enter your name to retry';
            if (onFail) onFail(res2);
            return;
          }
          state.code = res2.code;
          state.you = res2.you;
          // No need to call enterWaiting — server will push 'state' which transitions to game screen.
        });
        return;
      }
      toast(res.reason || 'Could not join', true);
      const status = $('#autojoin-status');
      if (status) status.textContent = (res.reason || 'Could not join') + ' — enter your name to retry';
      if (onFail) onFail(res);
      return;
    }
    state.code = res.code;
    state.you = res.you;
    enterWaiting();
  });
}

function openNamePrompt(code) {
  $('#name-modal-code').textContent = code;
  $('#name-modal-input').value = state.myName || '';
  $('#name-modal').classList.remove('hidden');
  // Focus after a tick so the modal is laid out
  setTimeout(() => $('#name-modal-input').focus(), 30);
}
function closeNamePrompt() { $('#name-modal').classList.add('hidden'); }

$('#name-modal-confirm').addEventListener('click', () => {
  const name = $('#name-modal-input').value.trim();
  if (!name) { $('#name-modal-input').focus(); return; }
  saveName(name);
  closeNamePrompt();
  doJoin(autoJoinRoom, name);
});
$('#name-modal-cancel').addEventListener('click', () => {
  closeNamePrompt();
  // Drop the room param so refresh doesn't re-prompt
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url.toString());
});
$('#name-modal-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#name-modal-confirm').click();
});

// --- Socket setup ---
function connect() {
  state.socket = io({ transports: ['websocket', 'polling'] });
  state.socket.on('lobby', renderLobbyState);
  state.socket.on('state', renderState);
  state.socket.on('chat', onChatMessage);
  state.socket.on('definitions', showDefinitions);
  state.socket.on('peer-disconnected', ({ who }) => {
    const name = state.players[who]?.name || 'Opponent';
    showPeerStatus(`${name} disconnected`, false);
    Sounds.play('peerLeft');
    addSystemChat(`${name} left the game`);
  });
  state.socket.on('peer-rejoined', ({ who, name }) => {
    const display = name || state.players[who]?.name || 'Opponent';
    showPeerStatus(`${display} reconnected`, true);
    setTimeout(hidePeerStatus, 2500);
    Sounds.play('peerBack');
    addSystemChat(`${display} rejoined`);
  });
  state.socket.on('disconnect', () => toast('Disconnected from server', true));
  state.socket.on('connect', () => {
    if (autoJoinRoom && !state.code) {
      // Always confirm the name when arriving via a share link — even if one is saved,
      // since it could be a different person on this device.
      openNamePrompt(autoJoinRoom);
    }
  });
}

connect();
