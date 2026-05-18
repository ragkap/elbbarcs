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
  selectedRackIndex: null, // rack index currently selected for tap-to-place
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
  state.socket.emit('create', { name }, async (res) => {
    if (!res.ok) return toast(res.reason, true);
    state.code = res.code; state.you = res.you;
    enterWaiting();
    // Try to auto-copy the invite link. Browsers gate clipboard writes to a
    // direct user-gesture window, which the async server roundtrip may have
    // closed, so this is best-effort. Surface either outcome to the user so
    // they always know what happened.
    let ok = false;
    try { ok = await copyText(shareLink()); } catch (e) {}
    if (ok) {
      Sounds.play('copy');
      toast('Invite link copied — paste it to your opponent');
      const hint = $('#waiting-hint');
      if (hint) hint.textContent = '✓ Invite link copied. Paste it to your opponent.';
    } else {
      // Couldn't auto-copy. Make the Copy Link button the call-to-action.
      const hint = $('#waiting-hint');
      if (hint) hint.textContent = 'Tap Copy Link to share with your opponent.';
    }
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

function flashButton(btn, label, kind = 'success') {
  const original = btn.dataset.original || btn.innerHTML;
  btn.dataset.original = original;
  btn.innerHTML = label;
  btn.classList.add('flash', kind);
  btn.disabled = true;
  setTimeout(() => {
    btn.innerHTML = btn.dataset.original;
    btn.classList.remove('flash', 'success', 'error');
    btn.disabled = false;
  }, 1400);
}

$('#copy-link-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const link = shareLink();
  const ok = await copyText(link);
  Sounds.play(ok ? 'copy' : 'error');
  flashButton(btn, ok ? '✓ Copied!' : '✕ Failed', ok ? 'success' : 'error');
  if (!ok) toast('Copy failed — link: ' + link, true);
});

$('#share-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const link = shareLink();
  const data = {
    title: 'elbbarcs',
    text: `Join my elbbarcs game — code ${state.code}`,
    url: link
  };
  if (navigator.share) {
    flashButton(btn, '↗ Opening…', 'success');
    try {
      await navigator.share(data);
      Sounds.play('copy');
      flashButton(btn, '✓ Shared!', 'success');
    } catch (err) {
      // User dismissed share sheet — silently restore.
      flashButton(btn, '↗ Share via app…', 'success');
    }
  } else {
    const ok = await copyText(link);
    Sounds.play(ok ? 'copy' : 'error');
    flashButton(btn, ok ? '✓ Link copied' : '✕ Failed', ok ? 'success' : 'error');
    if (!ok) toast('Copy failed', true);
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

// Dictionary, loaded lazily once a game starts. Used for projected-score word validity.
let clientDictionary = null;
let dictionaryLoading = false;
async function ensureDictionary() {
  if (clientDictionary || dictionaryLoading) return;
  dictionaryLoading = true;
  try {
    const [main, extra] = await Promise.all([
      fetch('/words.txt').then(r => r.text()),
      fetch('/words-extra.txt').then(r => r.text()).catch(() => '')
    ]);
    const set = new Set();
    for (const line of main.split(/\r?\n/)) {
      const w = line.trim().toUpperCase();
      if (w) set.add(w);
    }
    for (const line of extra.split(/\r?\n/)) {
      const w = line.trim().toUpperCase();
      if (w) set.add(w);
    }
    clientDictionary = set;
    updateProjectedScore();
  } catch (e) {
    // Network error — projected score will fall back to "calculating" without validity.
    dictionaryLoading = false;
  }
}

function renderState(s) {
  ensureDictionary();
  const wasMine = prevTurn != null && prevTurn === s.you;
  const isMine = s.turn === s.you;
  const historyGrew = s.history.length > prevHistoryLen;
  const justEnded = s.over && !prevOver;
  const prevScores = state.scores ? state.scores.slice() : [0, 0];

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
  state.moveNumber = s.moveNumber || 0;
  state.lastMove = s.lastMove || null;
  state.pending = []; // a fresh state from server clears any local pending move

  // Scoreboard — animate when a score actually changes
  for (let i = 0; i < 2; i++) {
    const el = $('#p' + i + '-score');
    el.querySelector('.name').textContent = s.players[i] ? s.players[i].name : '—';
    const valEl = el.querySelector('.val');
    const newScore = s.scores[i];
    if (prevScores[i] !== newScore && prevScores[i] != null) {
      animateScoreTo(valEl, prevScores[i], newScore);
    } else {
      valEl.textContent = newScore;
    }
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
    // New move arrived — clear the animated-already set so the fresh tiles get
    // the drop-in + last-move highlight on render.
    resetLastMoveAnimation();
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
  updateProjectedScore();
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
  // Build set of "last move" cell keys so opponent's freshly placed tiles glow.
  const lastMoveCells = new Set();
  if (state.lastMove && state.lastMove.type === 'move' && state.lastMove.placements) {
    for (const p of state.lastMove.placements) lastMoveCells.add(p.row + ',' + p.col);
  }
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
        const tile = makeTileEl(onBoard.letter, onBoard.blank, false);
        const key = r + ',' + c;
        if (lastMoveCells.has(key) && !renderedLastMove.has(key)) {
          tile.classList.add('placed', 'last-move');
          renderedLastMove.add(key);
        }
        cell.appendChild(tile);
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
// Cells we've already animated for the current "last move" — prevents
// re-triggering the animation when renderBoard runs again during the same move.
let renderedLastMove = new Set();
function resetLastMoveAnimation() { renderedLastMove = new Set(); }

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
  // If the currently-selected rack index has been emptied (because the tile was
  // placed or the rack was reordered), clear selection.
  if (state.selectedRackIndex != null) {
    const t = state.rack[state.selectedRackIndex];
    const used = state.pending.find(p => p.rackIndex === state.selectedRackIndex);
    if (!t || used) state.selectedRackIndex = null;
  }
  for (let i = 0; i < 7; i++) {
    const slot = document.createElement('div');
    slot.className = 'rack-slot';
    slot.dataset.idx = i;
    const tile = state.rack[i];
    const usedHere = state.pending.find(p => p.rackIndex === i);
    if (tile && !usedHere) {
      // Blanks display as a star — visually distinct from a missing tile, and the
      // chosen letter gets shown after placement (with .blank styling).
      const display = tile === '_' ? '★' : tile;
      const t = makeTileEl(display, tile === '_', false);
      t.dataset.rackIndex = i;
      if (tile === '_') t.title = 'Blank tile — choose its letter when placing';
      if (state.selectedRackIndex === i) t.classList.add('selected');
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

// Distance (px) the pointer must travel before we consider a press to be a drag.
// Below this threshold we treat pointerup as a tap and route it through the
// tap-to-place flow instead of running drop logic.
const DRAG_THRESHOLD = 8;

function startDrag(ev, sourceEl, source) {
  ev.preventDefault();
  const rect = sourceEl.getBoundingClientRect();
  drag = {
    source,
    sourceEl,
    pointerId: ev.pointerId,
    ghost: null,
    width: rect.width,
    height: rect.height,
    dropTarget: null,
    startX: ev.clientX,
    startY: ev.clientY,
    moved: false
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onEnd);
  document.addEventListener('pointercancel', onEnd);
}

function ensureGhost(ev) {
  if (drag.ghost || !drag.sourceEl) return;
  const g = drag.sourceEl.cloneNode(true);
  // Strip state classes from the clone so .selected's lift-transform doesn't
  // override the ghost's centering transform — that would put the ghost away
  // from the finger and make drop targeting feel broken.
  g.classList.remove('selected', 'fresh', 'last-move', 'placed');
  g.classList.add('drag-ghost');
  g.style.width = drag.width + 'px';
  g.style.height = drag.height + 'px';
  g.style.left = ev.clientX + 'px';
  g.style.top = ev.clientY + 'px';
  document.body.appendChild(g);
  drag.ghost = g;
  drag.sourceEl.style.opacity = '0.25';
}

function onMove(ev) {
  if (!drag) return;
  // Hold off building the ghost until the pointer crosses a threshold —
  // so brief taps don't visually flash a dragged tile.
  if (!drag.moved) {
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
    drag.moved = true;
    // Clear tap-selection state when a real drag begins so the source tile
    // isn't stuck in its lifted/selected visual.
    if (state.selectedRackIndex != null) {
      state.selectedRackIndex = null;
      renderRack();
    }
    ensureGhost(ev);
  }
  drag.ghost.style.left = ev.clientX + 'px';
  drag.ghost.style.top = ev.clientY + 'px';
  drag.ghost.style.display = 'none';
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  drag.ghost.style.display = '';
  if (drag.dropTarget) drag.dropTarget.classList.remove('drop-target');
  drag.dropTarget = null;
  if (!under) return;
  const cell = under.closest('.cell');
  const slot = under.closest('.rack-slot');
  if (cell && !cell.querySelector('.tile') && state.turn === state.you) {
    drag.dropTarget = cell;
    cell.classList.add('drop-target');
  } else if (slot) {
    if (drag.source.kind === 'rack' && +slot.dataset.idx === drag.source.rackIndex) return;
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
  const wasTap = !drag.moved;
  if (target) target.classList.remove('drop-target');
  if (drag.ghost) drag.ghost.remove();
  if (drag.sourceEl) drag.sourceEl.style.opacity = '';
  drag = null;

  // Tap behavior: select or place via the tap-to-place flow rather than running drop logic.
  if (wasTap) {
    handleTap(src, ev);
    return;
  }

  if (!target) {
    // No valid drop. Figure out where the user dropped to give helpful feedback.
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const overBoard = under?.closest('.board');
    const overRack = under?.closest('.rack');
    if (overBoard) {
      // They tried to drop on the board.
      if (state.turn !== state.you) {
        toast("It's not your turn yet", true);
      } else {
        // Either an occupied cell or somewhere ambiguous — tell them.
        toast('Drop on an empty square', true);
      }
    } else if (!overBoard && !overRack && src.kind === 'board') {
      // Dropped well outside the rack/board — recall the pending tile.
      removePending(src.rackIndex);
      renderBoard(); renderRack(); updateProjectedScore();
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
      // Drag from board back to rack — recall this pending placement.
      removePending(src.rackIndex);
      renderBoard(); renderRack(); updateProjectedScore();
    } else if (src.kind === 'rack' && newIdx !== src.rackIndex) {
      // Rack-to-rack: move the dragged tile to newIdx, shifting other tiles to make room.
      // This keeps every tile's rackIndex consistent on the server (it's still the same
      // letter at the same array position from the server's view — we just reorder our
      // local copy and the pending placements that reference these indices).
      reorderRack(src.rackIndex, newIdx);
      renderRack();
    }
  }
}

// --- Tap-to-place ---
// state.selectedRackIndex is the rack tile awaiting placement.
function handleTap(src, ev) {
  // Tap on a rack tile: select/deselect it (or place if a board cell was tapped — handled below).
  if (src.kind === 'rack') {
    if (state.selectedRackIndex === src.rackIndex) {
      state.selectedRackIndex = null; // toggle off
    } else {
      state.selectedRackIndex = src.rackIndex;
    }
    renderRack();
    return;
  }
  // Tap on a pending board tile: recall it.
  if (src.kind === 'board') {
    removePending(src.rackIndex);
    renderBoard(); renderRack(); updateProjectedScore();
    return;
  }
}

// Listen for taps on empty board cells — if a rack tile is selected, place it.
// Use both 'click' (desktop) and 'pointerup' (mobile) since Safari sometimes
// suppresses click on non-cursor:pointer elements.
function handleBoardTap(ev) {
  const cell = ev.target.closest('.cell');
  if (!cell) return;
  // Skip if the tap was actually on a pending tile (the other handler recalls it).
  if (cell.querySelector('.tile[data-pending]')) return;
  // Skip if a drag is in progress / just ended.
  if (drag && drag.moved) return;
  if (state.turn !== state.you) return;
  if (state.board[+cell.dataset.r][+cell.dataset.c]) return; // already a real tile
  if (state.selectedRackIndex == null) return;
  const idx = state.selectedRackIndex;
  state.selectedRackIndex = null;
  placeTileFrom({ kind: 'rack', rackIndex: idx }, +cell.dataset.r, +cell.dataset.c);
}
boardEl.addEventListener('click', handleBoardTap);

// Move state.rack[fromIdx] to position toIdx, shifting tiles between them.
// Also remap rackIndex on any pending placements so they continue to point at the
// same letter after reorder.
function reorderRack(fromIdx, toIdx) {
  if (fromIdx === toIdx) return;
  const tile = state.rack[fromIdx];
  // Remove from old position, insert at new
  state.rack.splice(fromIdx, 1);
  state.rack.splice(toIdx, 0, tile);
  // Remap pending placements' rackIndex
  for (const p of state.pending) {
    if (p.rackIndex === fromIdx) {
      p.rackIndex = toIdx;
    } else if (fromIdx < toIdx && p.rackIndex > fromIdx && p.rackIndex <= toIdx) {
      p.rackIndex -= 1;
    } else if (fromIdx > toIdx && p.rackIndex >= toIdx && p.rackIndex < fromIdx) {
      p.rackIndex += 1;
    }
  }
}

function placeTileFrom(src, row, col) {
  // Cannot place on existing board tile
  if (state.board[row][col]) { toast('Square already occupied', true); return; }
  // Cannot place if not your turn
  if (state.turn !== state.you) { toast("It's not your turn", true); return; }

  if (src.kind === 'rack') {
    const rackIndex = src.rackIndex;
    const letter = state.rack[rackIndex];
    if (letter == null) {
      // Rack index now points to nothing (e.g. tile already pending). Bail with a message.
      toast('That tile is no longer on the rack', true);
      return;
    }
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
    renderBoard(); renderRack(); updateProjectedScore();
  }
}

function addPending(p) {
  // Replace any existing pending with same rackIndex (shouldn't happen since rack slot empties)
  state.pending = state.pending.filter(pp => pp.rackIndex !== p.rackIndex);
  state.pending.push(p);
  Sounds.play('tilePlace');
  renderBoard(); renderRack(); updateProjectedScore(); updateProjectedScore();
}
function removePending(rackIndex) {
  state.pending = state.pending.filter(p => p.rackIndex !== rackIndex);
  Sounds.play('tileRecall');
}

function updateProjectedScore() {
  const el = $('#projected-score');
  const playBtn = $('#play-btn');
  if (!el) return;
  // Always-on: keep the panel reserving layout space so the board doesn't jump
  // when tiles are placed/recalled. Show a hint when there's nothing to score.
  if (!state.board || state.pending.length === 0) {
    el.classList.remove('valid', 'invalid');
    el.classList.add('idle');
    el.innerHTML = '<span class="placeholder">Place tiles to see your score</span>';
    if (playBtn) {
      playBtn.disabled = true;
      playBtn.title = 'Place tiles first';
    }
    return;
  }
  el.classList.remove('idle');
  const result = window.Scoring.projectScore({
    board: state.board,
    placements: state.pending.map(p => ({ row: p.row, col: p.col, letter: p.letter, blank: !!p.blank })),
    moveNumber: state.moveNumber || 0,
    dictionary: clientDictionary
  });

  if (!result.ok) {
    el.classList.remove('valid', 'invalid');
    el.innerHTML = `<span>${escapeHtml(prettyReason(result.reason))}</span>`;
    if (playBtn) {
      playBtn.disabled = true;
      playBtn.title = prettyReason(result.reason);
    }
    return;
  }

  const allValid = result.allWordsValid;
  el.classList.toggle('valid', allValid === true);
  el.classList.toggle('invalid', allValid === false);

  const wordPills = result.words.map(w => {
    const cls = w.valid === true ? 'good' : w.valid === false ? 'bad' : '';
    return `<span class="word-pill ${cls}">${escapeHtml(w.word)} ·<strong>${w.score}</strong></span>`;
  }).join('');

  const bingoLabel = result.bingo ? '<span class="bingo-label">BINGO +50</span>' : '';
  const status = allValid === true ? '✓' : allValid === false ? '✕' : '…';
  el.innerHTML = `${wordPills}${bingoLabel}<span class="score-value">${status} ${result.score}</span>`;

  if (playBtn) {
    // Allow Play if every formed word is in the dictionary, OR the dictionary
    // hasn't loaded yet (let the server be authoritative). Disable when any
    // word is known-invalid.
    const blocked = allValid === false;
    playBtn.disabled = blocked || state.turn !== state.you;
    playBtn.title = blocked
      ? 'One of these isn\'t a valid word'
      : state.turn !== state.you ? 'Not your turn' : 'Submit move';
  }
}

function prettyReason(r) {
  switch (r) {
    case 'no tiles': return '';
    case 'not a line': return 'Tiles must be in one row or column';
    case 'gap': return 'Tiles must be contiguous';
    case 'must cover center': return 'Place a tile on the center ★ to start';
    case 'word must be >= 2 letters': return 'Add another tile — words must be 2+ letters';
    case 'must connect to existing tiles': return 'Place a tile next to an existing word';
    default: return r || '';
  }
}

// Tap on a placed pending tile to recall it
boardEl.addEventListener('click', (ev) => {
  const tileEl = ev.target.closest('.tile[data-pending]');
  if (!tileEl) return;
  const cell = tileEl.parentElement;
  const r = +cell.dataset.r, c = +cell.dataset.c;
  const p = state.pending.find(pp => pp.row === r && pp.col === c);
  if (p) { removePending(p.rackIndex); renderBoard(); renderRack(); updateProjectedScore(); }
});

// Pointerdown on rack tiles starts a drag
rackEl.addEventListener('pointerdown', (ev) => {
  const tile = ev.target.closest('.tile[data-rack-index]');
  if (!tile) return;
  // Rack reordering is always allowed (purely local). Board placement is
  // still gated to your turn — enforced where the drop is resolved.
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
  state.pending = []; renderBoard(); renderRack(); updateProjectedScore();
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
    row: p.row, col: p.col, letter: p.letter, rackIndex: p.rackIndex,
    blank: !!p.blank // critical: tells server to consume a blank, not a letter tile
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
// --- Blank picker ---
function promptBlank(cb) {
  const grid = $('#blank-letters');
  const input = $('#blank-input');     // may be null on a cached HTML missing the input
  const confirmBtn = $('#blank-confirm');
  if (!grid) {
    // Fail loudly but recoverably — fall back to a plain prompt() so the user
    // is never stuck. Picker DOM is missing entirely.
    const v = (window.prompt('Choose a letter for the blank tile (A–Z)') || '').trim().toUpperCase();
    if (/^[A-Z]$/.test(v)) cb(v);
    return;
  }
  if (input) input.value = '';
  grid.innerHTML = '';
  // Live preview as user types — input also auto-confirms on first valid keystroke.
  if (input) {
    input.oninput = () => {
      const v = (input.value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1);
      input.value = v;
      if (v) {
        closeBlank();
        cb(v);
      }
    };
    input.onkeydown = (e) => {
      if (e.key === 'Escape') closeBlank();
    };
  }
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i);
    const b = document.createElement('button');
    b.textContent = ch;
    b.type = 'button';
    b.addEventListener('click', () => { closeBlank(); cb(ch); });
    grid.appendChild(b);
  }
  $('#blank-modal').classList.remove('hidden');
  // Don't try to auto-focus on mobile — it doesn't always trigger the keyboard
  // and feels broken. The alphabet grid is the primary path; the input is for
  // desktop users who'd rather type.

  if (confirmBtn) {
    confirmBtn.onclick = () => {
      const v = ((input && input.value) || '').trim().toUpperCase();
      if (!/^[A-Z]$/.test(v)) return;
      closeBlank();
      cb(v);
    };
  }
}
function closeBlank() {
  const modal = $('#blank-modal');
  if (modal) modal.classList.add('hidden');
  const input = $('#blank-input');
  if (input) {
    input.onkeydown = null;
    input.oninput = null;
  }
}
const blankCancelBtn = $('#blank-cancel');
if (blankCancelBtn) blankCancelBtn.addEventListener('click', closeBlank);

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
  $('#rematch-status').classList.add('hidden');
  $('#end-rematch').disabled = false;
  $('#end-rematch').textContent = '↻ Rematch';
  $('#end-rematch').onclick = () => requestRematch();
  $('#end-lobby').onclick = () => location.reload();
}

function requestRematch() {
  const btn = $('#end-rematch');
  btn.disabled = true;
  btn.textContent = 'Asking opponent…';
  $('#rematch-status').textContent = 'Waiting for opponent to accept…';
  $('#rematch-status').classList.remove('hidden');
  state.socket.emit('rematch', {}, (res) => {
    if (!res.ok) {
      toast(res.reason || 'Could not start rematch', true);
      btn.disabled = false;
      btn.textContent = '↻ Rematch';
      $('#rematch-status').classList.add('hidden');
      return;
    }
    // Switch our local state to the new room. Server will broadcast the new
    // lobby state (with us as the only player so far) which closes this modal
    // automatically once the opponent joins and the game starts.
    state.code = res.code;
    state.you = 0;
    enterWaiting();
    $('#end-modal').classList.add('hidden');
  });
}

// Handle incoming rematch invitation from the opponent.
function showRematchInvite(code) {
  const modal = $('#rematch-invite');
  modal.classList.remove('hidden');
  $('#rematch-accept').onclick = () => {
    modal.classList.add('hidden');
    state.socket.emit('join', { code, name: state.myName }, (res) => {
      if (!res.ok) {
        toast(res.reason || 'Could not join rematch', true);
        return;
      }
      state.code = res.code;
      state.you = res.you;
      $('#end-modal').classList.add('hidden');
      enterWaiting();
    });
  };
  $('#rematch-decline').onclick = () => {
    modal.classList.add('hidden');
  };
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

// Tween a score display from one number to another over ~600ms with a
// brief "changing" class for the CSS pulse.
function animateScoreTo(el, from, to) {
  const start = performance.now();
  const dur = 600;
  el.classList.add('changing');
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
    else {
      el.textContent = to;
      setTimeout(() => el.classList.remove('changing'), 100);
    }
  }
  requestAnimationFrame(step);
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

  // Reaction row
  const reactionRow = $('#reaction-row');
  if (reactionRow && !reactionRow.dataset.wired) {
    reactionRow.dataset.wired = '1';
    const REACTIONS = ['👏','🔥','🤔','😂','😅','❤️','💀','🎉','👀','🤯'];
    for (const emoji of REACTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = emoji;
      b.addEventListener('click', () => sendReaction(emoji));
      reactionRow.appendChild(b);
    }
  }
}

function sendReaction(emoji) {
  state.socket.emit('reaction', { emoji });
  // Show locally immediately for snappiness; server echoes to peer.
  floatReaction(emoji, true);
}

function onIncomingReaction({ from, emoji }) {
  // Don't render our own echoed reaction twice
  if (from === state.you) return;
  floatReaction(emoji, false);
}

function floatReaction(emoji, mine) {
  const layer = $('#reaction-layer');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'reaction-float';
  el.textContent = emoji;
  // Mine: bottom-right; theirs: bottom-left — gives a visual sense of "who sent it".
  const x = mine ? 75 + Math.random() * 15 : 10 + Math.random() * 15;
  el.style.left = `${x}vw`;
  el.style.bottom = `12vh`;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2400);
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
  state.socket = io({
    transports: ['websocket', 'polling'],
    // Aggressively reconnect on disconnect — phones drop sockets all the time
    // (background tab, screen-lock, wifi handoff). The user shouldn't notice.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.3,
    timeout: 20000
  });
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
  state.socket.on('rematch-ready', ({ code }) => {
    showRematchInvite(code);
  });
  state.socket.on('reaction', onIncomingReaction);
  state.socket.on('disconnect', (reason) => {
    // 'io server disconnect' is intentional (server kicked us); everything else
    // is a network/transport blip and the client will auto-reconnect.
    if (reason === 'io server disconnect') {
      toast('Disconnected by server', true);
    } else {
      showPeerStatus('Reconnecting…', false);
    }
  });
  state.socket.on('connect', () => {
    // If we already have a room/name in this tab, we got reconnected after a blip.
    // Ask the server to put us back in the same slot so the user's game continues
    // without them having to do anything.
    if (state.code && state.myName) {
      state.socket.emit('rejoin', { code: state.code, name: state.myName }, (res) => {
        if (res && res.ok) {
          hidePeerStatus();
        } else if (res && /Room not found|No matching slot/i.test(res.reason || '')) {
          // Server lost the room (e.g. restarted while we were gone). Soft-reload to lobby.
          toast(res.reason, true);
        }
      });
    } else if (autoJoinRoom && !state.code) {
      // First-load via share link — confirm name on this device
      openNamePrompt(autoJoinRoom);
    }
  });
}

connect();

// When the page comes back to the foreground on mobile, force a socket check.
// iOS Safari pauses background tabs and the socket can be silently dead until
// the next ping; nudging it on visibilitychange makes recovery much faster.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.socket && !state.socket.connected) {
    state.socket.connect();
  }
});
