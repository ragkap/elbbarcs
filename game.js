'use strict';

const TILE_DISTRIBUTION = {
  A: { count: 9, value: 1 },
  B: { count: 2, value: 3 },
  C: { count: 2, value: 3 },
  D: { count: 4, value: 2 },
  E: { count: 12, value: 1 },
  F: { count: 2, value: 4 },
  G: { count: 3, value: 2 },
  H: { count: 2, value: 4 },
  I: { count: 9, value: 1 },
  J: { count: 1, value: 8 },
  K: { count: 1, value: 5 },
  L: { count: 4, value: 1 },
  M: { count: 2, value: 3 },
  N: { count: 6, value: 1 },
  O: { count: 8, value: 1 },
  P: { count: 2, value: 3 },
  Q: { count: 1, value: 10 },
  R: { count: 6, value: 1 },
  S: { count: 4, value: 1 },
  T: { count: 6, value: 1 },
  U: { count: 4, value: 1 },
  V: { count: 2, value: 4 },
  W: { count: 2, value: 4 },
  X: { count: 1, value: 8 },
  Y: { count: 2, value: 4 },
  Z: { count: 1, value: 10 },
  '_': { count: 2, value: 0 } // blanks
};

const BOARD_SIZE = 15;

// Premium squares: TW=triple word, DW=double word, TL=triple letter, DL=double letter
// Standard Scrabble layout. The center (7,7) is a DW (counts as star).
const PREMIUM_LAYOUT = (() => {
  const grid = Array.from({ length: BOARD_SIZE }, () =>
    Array(BOARD_SIZE).fill(null)
  );
  const set = (r, c, v) => { grid[r][c] = v; };
  // Triple word
  [[0,0],[0,7],[0,14],[7,0],[7,14],[14,0],[14,7],[14,14]].forEach(([r,c]) => set(r,c,'TW'));
  // Double word
  [[1,1],[2,2],[3,3],[4,4],[10,10],[11,11],[12,12],[13,13],
   [1,13],[2,12],[3,11],[4,10],[10,4],[11,3],[12,2],[13,1],
   [7,7]].forEach(([r,c]) => set(r,c,'DW'));
  // Triple letter
  [[1,5],[1,9],[5,1],[5,5],[5,9],[5,13],[9,1],[9,5],[9,9],[9,13],[13,5],[13,9]]
    .forEach(([r,c]) => set(r,c,'TL'));
  // Double letter
  [[0,3],[0,11],[2,6],[2,8],[3,0],[3,7],[3,14],[6,2],[6,6],[6,8],[6,12],
   [7,3],[7,11],[8,2],[8,6],[8,8],[8,12],[11,0],[11,7],[11,14],[12,6],[12,8],
   [14,3],[14,11]].forEach(([r,c]) => set(r,c,'DL'));
  return grid;
})();

function premiumAt(r, c) {
  return PREMIUM_LAYOUT[r][c];
}

function letterValue(letter) {
  return TILE_DISTRIBUTION[letter]?.value ?? 0;
}

function buildBag() {
  const bag = [];
  for (const [letter, info] of Object.entries(TILE_DISTRIBUTION)) {
    for (let i = 0; i < info.count; i++) bag.push(letter);
  }
  return bag;
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function emptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

/**
 * Create a fresh game state. Players is a list of {id, name}.
 */
function createGame(players) {
  const bag = shuffle(buildBag());
  const racks = players.map(() => bag.splice(0, 7));
  return {
    board: emptyBoard(),
    bag,
    racks,
    scores: players.map(() => 0),
    players,
    turn: 0,
    history: [],
    consecutivePasses: 0,
    over: false,
    winner: null,
    lastMove: null,
    moveNumber: 0
  };
}

/**
 * Validate placements: array of {row, col, letter, blank: bool, rackIndex}.
 * Returns {ok, reason} or {ok, words: [{word, score, cells}], totalScore, mainWord}.
 *
 * Rules enforced:
 * - All placements form a single line (row or column), contiguous (existing tiles can fill gaps).
 * - First move must cover center (7,7).
 * - Non-first move must touch at least one existing tile.
 * - All formed words (main + cross-words) must be ≥ 2 letters.
 */
function validateAndScore(state, placements, dictionary) {
  if (!placements || placements.length === 0) {
    return { ok: false, reason: 'No tiles placed' };
  }
  const board = state.board;

  // Detect duplicates and out-of-range
  const cellSet = new Set();
  for (const p of placements) {
    if (p.row < 0 || p.row >= BOARD_SIZE || p.col < 0 || p.col >= BOARD_SIZE) {
      return { ok: false, reason: 'Off-board placement' };
    }
    const k = p.row + ',' + p.col;
    if (cellSet.has(k)) return { ok: false, reason: 'Duplicate placement' };
    if (board[p.row][p.col]) return { ok: false, reason: 'Cell already occupied' };
    cellSet.add(k);
  }

  // Determine line
  const rows = new Set(placements.map(p => p.row));
  const cols = new Set(placements.map(p => p.col));
  let direction;
  if (rows.size === 1) direction = 'H';
  else if (cols.size === 1) direction = 'V';
  else return { ok: false, reason: 'Tiles must be in a single row or column' };

  // Sort
  const sorted = [...placements].sort((a, b) =>
    direction === 'H' ? a.col - b.col : a.row - b.row
  );

  // Check contiguity (allowing existing tiles between)
  if (direction === 'H') {
    const r = sorted[0].row;
    for (let c = sorted[0].col; c <= sorted[sorted.length - 1].col; c++) {
      const isPlaced = sorted.find(p => p.col === c);
      if (!isPlaced && !board[r][c]) {
        return { ok: false, reason: 'Tiles must be contiguous' };
      }
    }
  } else {
    const c = sorted[0].col;
    for (let r = sorted[0].row; r <= sorted[sorted.length - 1].row; r++) {
      const isPlaced = sorted.find(p => p.row === r);
      if (!isPlaced && !board[r][c]) {
        return { ok: false, reason: 'Tiles must be contiguous' };
      }
    }
  }

  // First-move and connection rules
  const isFirstMove = state.moveNumber === 0;
  if (isFirstMove) {
    const coversCenter = placements.some(p => p.row === 7 && p.col === 7);
    if (!coversCenter) return { ok: false, reason: 'First move must cover center' };
    if (placements.length < 2) return { ok: false, reason: 'First word must be at least 2 letters' };
  } else {
    // Must touch at least one existing tile
    const touches = placements.some(p => {
      const neighbors = [[-1,0],[1,0],[0,-1],[0,1]];
      return neighbors.some(([dr, dc]) => {
        const nr = p.row + dr, nc = p.col + dc;
        return nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc];
      });
    });
    if (!touches) return { ok: false, reason: 'Word must connect to existing tiles' };
  }

  // Build a virtual board with placements
  const virtual = board.map(row => row.slice());
  for (const p of placements) {
    virtual[p.row][p.col] = { letter: p.letter, blank: !!p.blank, fresh: true };
  }
  // Mark existing tiles as not fresh
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (virtual[r][c] && virtual[r][c].fresh === undefined) {
        // existing tile from board; copy was a reference — re-wrap to add fresh:false
        virtual[r][c] = { ...virtual[r][c], fresh: false };
      }
    }
  }

  // Helper: extract word along a direction starting at (r,c) by walking back to start.
  function extractWord(r, c, dir) {
    let sr = r, sc = c;
    if (dir === 'H') {
      while (sc > 0 && virtual[sr][sc - 1]) sc--;
      let word = '';
      const cells = [];
      let cc = sc;
      while (cc < BOARD_SIZE && virtual[sr][cc]) {
        word += virtual[sr][cc].letter;
        cells.push({ row: sr, col: cc, tile: virtual[sr][cc] });
        cc++;
      }
      return { word, cells };
    } else {
      while (sr > 0 && virtual[sr - 1][sc]) sr--;
      let word = '';
      const cells = [];
      let rr = sr;
      while (rr < BOARD_SIZE && virtual[rr][sc]) {
        word += virtual[rr][sc].letter;
        cells.push({ row: rr, col: sc, tile: virtual[rr][sc] });
        rr++;
      }
      return { word, cells };
    }
  }

  // Main word along the direction
  const main = extractWord(placements[0].row, placements[0].col, direction);
  if (main.word.length < 2) {
    return { ok: false, reason: 'Word must be at least 2 letters' };
  }

  const wordsFormed = [main];

  // Cross words at each placement
  const crossDir = direction === 'H' ? 'V' : 'H';
  for (const p of placements) {
    const cw = extractWord(p.row, p.col, crossDir);
    if (cw.word.length >= 2) wordsFormed.push(cw);
  }

  // Dictionary validation
  for (const w of wordsFormed) {
    if (!dictionary.has(w.word.toUpperCase())) {
      return { ok: false, reason: 'Invalid word: ' + w.word };
    }
  }

  // Score
  let totalScore = 0;
  const scoredWords = [];
  for (const w of wordsFormed) {
    let wordScore = 0;
    let wordMultiplier = 1;
    for (const cell of w.cells) {
      const isFresh = !!cell.tile.fresh;
      let letterScore = cell.tile.blank ? 0 : letterValue(cell.tile.letter);
      if (isFresh) {
        const prem = premiumAt(cell.row, cell.col);
        if (prem === 'DL') letterScore *= 2;
        else if (prem === 'TL') letterScore *= 3;
        else if (prem === 'DW') wordMultiplier *= 2;
        else if (prem === 'TW') wordMultiplier *= 3;
      }
      wordScore += letterScore;
    }
    wordScore *= wordMultiplier;
    scoredWords.push({ word: w.word, score: wordScore, cells: w.cells.map(c => ({ row: c.row, col: c.col })) });
    totalScore += wordScore;
  }

  // Bingo: all 7 tiles played → +50
  if (placements.length === 7) totalScore += 50;

  return { ok: true, words: scoredWords, totalScore, direction, mainWord: main.word };
}

/**
 * Apply a validated move. Removes tiles from rack, places on board, draws new tiles, advances turn.
 */
function applyMove(state, placements, scoreResult) {
  const player = state.turn;
  const rack = state.racks[player];
  // Remove tiles from rack by rackIndex (sorted desc to avoid shifting)
  const indices = placements.map(p => p.rackIndex).sort((a, b) => b - a);
  for (const idx of indices) rack.splice(idx, 1);
  // Place tiles
  for (const p of placements) {
    state.board[p.row][p.col] = { letter: p.letter, blank: !!p.blank };
  }
  // Score
  state.scores[player] += scoreResult.totalScore;
  // Refill
  while (rack.length < 7 && state.bag.length > 0) {
    rack.push(state.bag.shift());
  }
  state.consecutivePasses = 0;
  state.moveNumber++;
  state.lastMove = {
    player,
    placements: placements.map(p => ({ row: p.row, col: p.col, letter: p.letter, blank: !!p.blank })),
    words: scoreResult.words,
    score: scoreResult.totalScore,
    type: 'move'
  };
  state.history.push(state.lastMove);

  // End-game: rack empty and bag empty
  if (rack.length === 0 && state.bag.length === 0) {
    finishGame(state, player);
    return;
  }
  state.turn = (state.turn + 1) % state.players.length;
}

function finishGame(state, outPlayer) {
  // Subtract leftover rack values from each player; if a player went out, add the sum of others' leftovers to that player's score.
  let goneOutBonus = 0;
  for (let i = 0; i < state.players.length; i++) {
    let leftover = 0;
    for (const t of state.racks[i]) leftover += letterValue(t);
    if (i === outPlayer) {
      goneOutBonus += 0;
    } else {
      state.scores[i] -= leftover;
      goneOutBonus += leftover;
    }
  }
  if (outPlayer != null && state.racks[outPlayer].length === 0) {
    state.scores[outPlayer] += goneOutBonus;
  } else {
    // No one went out (six-pass termination): just deduct each player's rack from their own score.
    for (let i = 0; i < state.players.length; i++) {
      let leftover = 0;
      for (const t of state.racks[i]) leftover += letterValue(t);
      state.scores[i] -= leftover;
    }
  }
  state.over = true;
  let best = -Infinity, winner = null;
  for (let i = 0; i < state.scores.length; i++) {
    if (state.scores[i] > best) { best = state.scores[i]; winner = i; }
    else if (state.scores[i] === best) winner = -1; // tie
  }
  state.winner = winner;
}

function passTurn(state) {
  state.consecutivePasses++;
  state.history.push({ player: state.turn, type: 'pass' });
  state.lastMove = { player: state.turn, type: 'pass' };
  // Six consecutive passes (3 each in 2P) → end the game.
  if (state.consecutivePasses >= state.players.length * 3) {
    finishGame(state, null);
    return;
  }
  state.turn = (state.turn + 1) % state.players.length;
}

function exchangeTiles(state, rackIndices) {
  if (state.bag.length < 7) return { ok: false, reason: 'Not enough tiles in bag to exchange' };
  if (!rackIndices || rackIndices.length === 0) return { ok: false, reason: 'No tiles to exchange' };
  const rack = state.racks[state.turn];
  const idxs = [...new Set(rackIndices)].sort((a, b) => b - a);
  if (idxs.some(i => i < 0 || i >= rack.length)) return { ok: false, reason: 'Bad rack index' };
  const returned = [];
  for (const i of idxs) {
    returned.push(rack[i]);
    rack.splice(i, 1);
  }
  // Draw replacements
  const drawCount = returned.length;
  for (let i = 0; i < drawCount && state.bag.length > 0; i++) {
    rack.push(state.bag.shift());
  }
  // Return exchanged tiles to bag and reshuffle
  state.bag.push(...returned);
  shuffle(state.bag);
  state.consecutivePasses++;
  state.history.push({ player: state.turn, type: 'exchange', count: drawCount });
  state.lastMove = { player: state.turn, type: 'exchange', count: drawCount };
  if (state.consecutivePasses >= state.players.length * 3) {
    finishGame(state, null);
    return { ok: true };
  }
  state.turn = (state.turn + 1) % state.players.length;
  return { ok: true };
}

/**
 * Public view of the state for a given player. Hides the other player's rack and the bag contents.
 */
function publicView(state, playerIndex) {
  return {
    board: state.board,
    rack: playerIndex != null ? state.racks[playerIndex] : null,
    rackCount: state.racks.map(r => r.length),
    scores: state.scores,
    players: state.players.map(p => ({ id: p.id, name: p.name })),
    turn: state.turn,
    bagCount: state.bag.length,
    over: state.over,
    winner: state.winner,
    lastMove: state.lastMove,
    moveNumber: state.moveNumber,
    you: playerIndex,
    history: state.history,
    premium: PREMIUM_LAYOUT
  };
}

module.exports = {
  BOARD_SIZE,
  TILE_DISTRIBUTION,
  PREMIUM_LAYOUT,
  letterValue,
  createGame,
  validateAndScore,
  applyMove,
  passTurn,
  exchangeTiles,
  publicView,
  premiumAt
};
