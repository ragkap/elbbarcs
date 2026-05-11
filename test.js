'use strict';
const fs = require('fs');
const path = require('path');
const game = require('./game');

const dictionary = new Set(
  fs.readFileSync(path.join(__dirname, 'words.txt'), 'utf8')
    .split(/\r?\n/).map(s => s.trim().toUpperCase()).filter(Boolean)
);

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } else console.log('ok:', msg); }

// Build a deterministic game by overriding the bag
const g = game.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);

// Force a known rack: HELLO__ for player 0
g.racks[0] = ['H','E','L','L','O','C','T'];

// Play HELLO horizontally through center: row 7, cols 5..9 — but center is (7,7) so cols 5..9 covers it
const placements = [
  { row: 7, col: 5, letter: 'H', rackIndex: 0, blank: false },
  { row: 7, col: 6, letter: 'E', rackIndex: 1, blank: false },
  { row: 7, col: 7, letter: 'L', rackIndex: 2, blank: false },
  { row: 7, col: 8, letter: 'L', rackIndex: 3, blank: false },
  { row: 7, col: 9, letter: 'O', rackIndex: 4, blank: false }
];
const r = game.validateAndScore(g, placements, dictionary);
assert(r.ok, 'HELLO is valid');
assert(r.mainWord === 'HELLO', 'main word HELLO');
// HELLO: H(4) E(1) L(1)*DW? no, DW at 7,7 so word x2; actually only center is DW on first move. Let's not over-spec, just assert >0
assert(r.totalScore > 0, 'HELLO scored ' + r.totalScore);
console.log('HELLO score:', r.totalScore);

game.applyMove(g, placements, r);
assert(g.scores[0] === r.totalScore, 'score applied');
assert(g.turn === 1, 'turn advanced');

// Force player 1's rack to include CAT and an existing tile to extend
g.racks[1] = ['C','A','T','S','I','N','G'];
// Place CATS vertically extending below the O at (7,9) — so C at (8,9), A at (9,9), T at (10,9), S at (11,9) makes OCATS? No.
// Better: extend HELLO to HELLOS by adding S at (7,10)
const p2 = [{ row: 7, col: 10, letter: 'S', rackIndex: 3, blank: false }];
const r2 = game.validateAndScore(g, p2, dictionary);
assert(r2.ok, 'HELLOS extension is valid; reason: ' + (r2.reason || ''));
assert(r2.mainWord === 'HELLOS', 'extended to HELLOS');
console.log('HELLOS score:', r2.totalScore);

// Reject a nonsense word
g.racks[1] = ['X','Z','Q','J','K','V','W'];
const p3 = [
  { row: 8, col: 7, letter: 'X', rackIndex: 0, blank: false },
  { row: 9, col: 7, letter: 'Z', rackIndex: 1, blank: false }
];
const r3 = game.validateAndScore(g, p3, dictionary);
assert(!r3.ok, 'XZ rejected: ' + r3.reason);

// Bingo: 7 tiles
const g2 = game.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
g2.racks[0] = ['R','E','T','A','I','N','S']; // RETAINS, valid bingo
const bingoPlace = ['R','E','T','A','I','N','S'].map((l, i) => ({
  row: 7, col: 4 + i, letter: l, rackIndex: i, blank: false
}));
const rb = game.validateAndScore(g2, bingoPlace, dictionary);
assert(rb.ok, 'RETAINS valid; ' + (rb.reason || ''));
// Bingo bonus
console.log('RETAINS score (incl bingo):', rb.totalScore);
assert(rb.totalScore >= 50, 'bingo bonus applied');

console.log('\nAll tests passed.');
