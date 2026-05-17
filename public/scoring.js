'use strict';

// Client-side projected score calculator. Mirrors game.js#validateAndScore.
// Provides a quick, local check so the user sees their score as they place tiles.
// The server is still the authority on move acceptance.
// Wrapped in an IIFE so top-level consts (BOARD_SIZE, LETTER_VALUES, PREMIUM)
// don't collide with the same names in app.js.

(function () {
const BOARD_SIZE = 15;

const LETTER_VALUES = {
  A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10,'_':0
};

// Premium layout — must match server.
const PREMIUM = (() => {
  const grid = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  const set = (r, c, v) => { grid[r][c] = v; };
  [[0,0],[0,7],[0,14],[7,0],[7,14],[14,0],[14,7],[14,14]].forEach(([r,c]) => set(r,c,'TW'));
  [[1,1],[2,2],[3,3],[4,4],[10,10],[11,11],[12,12],[13,13],
   [1,13],[2,12],[3,11],[4,10],[10,4],[11,3],[12,2],[13,1],
   [7,7]].forEach(([r,c]) => set(r,c,'DW'));
  [[1,5],[1,9],[5,1],[5,5],[5,9],[5,13],[9,1],[9,5],[9,9],[9,13],[13,5],[13,9]]
    .forEach(([r,c]) => set(r,c,'TL'));
  [[0,3],[0,11],[2,6],[2,8],[3,0],[3,7],[3,14],[6,2],[6,6],[6,8],[6,12],
   [7,3],[7,11],[8,2],[8,6],[8,8],[8,12],[11,0],[11,7],[11,14],[12,6],[12,8],
   [14,3],[14,11]].forEach(([r,c]) => set(r,c,'DL'));
  return grid;
})();

/**
 * Compute the projected score for a placement.
 * @param {Object} args
 *  - board: 15x15 grid of {letter, blank} | null
 *  - placements: [{row, col, letter, blank}]
 *  - moveNumber: int (so we know if this is the first move)
 *  - dictionary: Set of uppercase valid words, or null if not yet loaded
 * @returns {Object} { ok, reason?, score?, words?, allWordsValid?, partial? }
 *   - partial: true if structurally valid but not enough info for full validation
 */
function projectScore({ board, placements, moveNumber, dictionary }) {
  if (!placements || placements.length === 0) return { ok: false, reason: 'no tiles' };

  // Single-line check
  const rows = new Set(placements.map(p => p.row));
  const cols = new Set(placements.map(p => p.col));
  let direction;
  if (rows.size === 1) direction = 'H';
  else if (cols.size === 1) direction = 'V';
  else return { ok: false, reason: 'not a line' };

  const sorted = [...placements].sort((a, b) =>
    direction === 'H' ? a.col - b.col : a.row - b.row
  );

  // Contiguity (allow existing board tiles to fill gaps)
  if (direction === 'H') {
    const r = sorted[0].row;
    for (let c = sorted[0].col; c <= sorted[sorted.length - 1].col; c++) {
      const isPlaced = sorted.find(p => p.col === c);
      if (!isPlaced && !board[r][c]) return { ok: false, reason: 'gap' };
    }
  } else {
    const c = sorted[0].col;
    for (let r = sorted[0].row; r <= sorted[sorted.length - 1].row; r++) {
      const isPlaced = sorted.find(p => p.row === r);
      if (!isPlaced && !board[r][c]) return { ok: false, reason: 'gap' };
    }
  }

  // First-move / connection check
  const isFirstMove = moveNumber === 0;
  if (isFirstMove) {
    const coversCenter = placements.some(p => p.row === 7 && p.col === 7);
    if (!coversCenter) return { ok: false, reason: 'must cover center' };
    if (placements.length < 2) return { ok: false, reason: 'word must be >= 2 letters' };
  } else {
    const touches = placements.some(p => {
      const neighbors = [[-1,0],[1,0],[0,-1],[0,1]];
      return neighbors.some(([dr, dc]) => {
        const nr = p.row + dr, nc = p.col + dc;
        return nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc];
      });
    });
    if (!touches) return { ok: false, reason: 'must connect to existing tiles' };
  }

  // Build virtual board
  const virtual = board.map(row => row.slice());
  for (const p of placements) {
    virtual[p.row][p.col] = { letter: p.letter, blank: !!p.blank, fresh: true };
  }
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (virtual[r][c] && virtual[r][c].fresh === undefined) {
        virtual[r][c] = { ...virtual[r][c], fresh: false };
      }
    }
  }

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

  const main = extractWord(placements[0].row, placements[0].col, direction);
  if (main.word.length < 2) return { ok: false, reason: 'word must be >= 2 letters' };

  const wordsFormed = [main];
  const crossDir = direction === 'H' ? 'V' : 'H';
  for (const p of placements) {
    const cw = extractWord(p.row, p.col, crossDir);
    if (cw.word.length >= 2) wordsFormed.push(cw);
  }

  // Score
  let totalScore = 0;
  const scoredWords = [];
  let allValid = true;
  for (const w of wordsFormed) {
    let wordScore = 0;
    let wordMultiplier = 1;
    for (const cell of w.cells) {
      const isFresh = !!cell.tile.fresh;
      let letterScore = cell.tile.blank ? 0 : (LETTER_VALUES[cell.tile.letter] || 0);
      if (isFresh) {
        const prem = PREMIUM[cell.row][cell.col];
        if (prem === 'DL') letterScore *= 2;
        else if (prem === 'TL') letterScore *= 3;
        else if (prem === 'DW') wordMultiplier *= 2;
        else if (prem === 'TW') wordMultiplier *= 3;
      }
      wordScore += letterScore;
    }
    wordScore *= wordMultiplier;
    const valid = dictionary ? dictionary.has(w.word.toUpperCase()) : null;
    if (valid === false) allValid = false;
    scoredWords.push({ word: w.word, score: wordScore, valid });
    totalScore += wordScore;
  }
  if (placements.length === 7) totalScore += 50;

  return {
    ok: true,
    score: totalScore,
    words: scoredWords,
    allWordsValid: dictionary ? allValid : null,
    partial: !dictionary,
    mainWord: main.word,
    bingo: placements.length === 7
  };
}

window.Scoring = { projectScore, LETTER_VALUES };
})();
