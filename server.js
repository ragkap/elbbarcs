'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const game = require('./game');

const PORT = process.env.PORT || 3000;

// Load dictionary
const dictPath = path.join(__dirname, 'words.txt');
const dictionary = new Set();
{
  const raw = fs.readFileSync(dictPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const w = line.trim().toUpperCase();
    if (w) dictionary.add(w);
  }
  console.log(`Loaded ${dictionary.size} dictionary words.`);
}

const app = express();
// Block search engines at the HTTP-header level too (belt + braces alongside meta + robots.txt).
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, words: dictionary.size }));

// --- Definitions ---
// Look up word meanings via dictionaryapi.dev with an in-memory cache.
// Returns { word, partOfSpeech, definition } | null. Best-effort; many Scrabble-valid
// words (esp. plurals/inflections/obscure) won't be in the consumer dictionary API.
const defCache = new Map();
const DEF_CACHE_LIMIT = 5000;

async function fetchDefinition(word) {
  const key = word.toUpperCase();
  if (defCache.has(key)) return defCache.get(key);

  let result = null;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2500);
    const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key.toLowerCase())}`, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data) && data[0]) {
        const entry = data[0];
        const meaning = entry.meanings && entry.meanings[0];
        const def = meaning && meaning.definitions && meaning.definitions[0];
        if (def && def.definition) {
          result = {
            word: entry.word || key,
            partOfSpeech: meaning.partOfSpeech || '',
            definition: def.definition,
            example: def.example || ''
          };
        }
      }
    }
  } catch (e) { /* network or timeout — return null */ }

  // Cap cache size — evict oldest if full
  if (defCache.size >= DEF_CACHE_LIMIT) {
    const firstKey = defCache.keys().next().value;
    defCache.delete(firstKey);
  }
  defCache.set(key, result);
  return result;
}

async function lookupWords(words) {
  return Promise.all(words.map(w => fetchDefinition(w).then(def => ({ word: w, def }))));
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/**
 * Rooms map: code -> {
 *   code, players: [{id, name, socketId}], state: gameState | null, createdAt
 * }
 */
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function broadcastRoom(room) {
  if (!room.state) {
    // Lobby update
    for (const p of room.players) {
      io.to(p.socketId).emit('lobby', {
        code: room.code,
        players: room.players.map(pl => ({ name: pl.name })),
        you: room.players.findIndex(pl => pl.id === p.id)
      });
    }
    return;
  }
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    io.to(p.socketId).emit('state', game.publicView(room.state, i));
  }
}

function findPlayerIndex(room, socketId) {
  return room.players.findIndex(p => p.socketId === socketId);
}

io.on('connection', (socket) => {
  let joinedRoom = null;
  let playerId = null;

  socket.on('create', ({ name }, ack) => {
    if (joinedRoom) return ack && ack({ ok: false, reason: 'Already in a room' });
    const code = genCode();
    playerId = socket.id + '-' + Date.now();
    const room = {
      code,
      players: [{ id: playerId, name: (name || 'Player 1').slice(0, 16), socketId: socket.id }],
      state: null,
      createdAt: Date.now()
    };
    rooms.set(code, room);
    joinedRoom = code;
    socket.join(code);
    ack && ack({ ok: true, code, you: 0 });
    broadcastRoom(room);
  });

  socket.on('join', ({ code, name }, ack) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, reason: 'Room not found' });
    if (room.state) return ack && ack({ ok: false, reason: 'Game already started' });
    if (room.players.length >= 2) return ack && ack({ ok: false, reason: 'Room full' });
    playerId = socket.id + '-' + Date.now();
    room.players.push({ id: playerId, name: (name || 'Player 2').slice(0, 16), socketId: socket.id });
    joinedRoom = code;
    socket.join(code);
    ack && ack({ ok: true, code, you: room.players.length - 1 });
    broadcastRoom(room);
  });

  socket.on('start', (_data, ack) => {
    if (!joinedRoom) return ack && ack({ ok: false, reason: 'No room' });
    const room = rooms.get(joinedRoom);
    if (!room) return ack && ack({ ok: false, reason: 'Room missing' });
    if (room.state) return ack && ack({ ok: false, reason: 'Already started' });
    if (room.players.length < 2) return ack && ack({ ok: false, reason: 'Need 2 players' });
    room.state = game.createGame(room.players.map(p => ({ id: p.id, name: p.name })));
    ack && ack({ ok: true });
    broadcastRoom(room);
  });

  socket.on('move', ({ placements }, ack) => {
    if (!joinedRoom) return ack && ack({ ok: false, reason: 'No room' });
    const room = rooms.get(joinedRoom);
    if (!room || !room.state) return ack && ack({ ok: false, reason: 'No game' });
    const me = findPlayerIndex(room, socket.id);
    if (me !== room.state.turn) return ack && ack({ ok: false, reason: 'Not your turn' });

    // Verify each placement comes from this player's rack and the rackIndex is in range
    const rack = room.state.racks[me];
    const used = new Set();
    for (const p of placements) {
      if (typeof p.rackIndex !== 'number' || p.rackIndex < 0 || p.rackIndex >= rack.length) {
        return ack && ack({ ok: false, reason: 'Invalid rack index' });
      }
      if (used.has(p.rackIndex)) {
        return ack && ack({ ok: false, reason: 'Duplicate rack tile' });
      }
      used.add(p.rackIndex);
      const rackTile = rack[p.rackIndex];
      if (rackTile === '_') {
        // Blank tile: must specify chosen letter
        if (!p.letter || !/^[A-Z]$/.test(p.letter)) {
          return ack && ack({ ok: false, reason: 'Blank needs a letter' });
        }
        p.blank = true;
      } else {
        if (rackTile !== (p.letter || '').toUpperCase()) {
          return ack && ack({ ok: false, reason: 'Tile mismatch' });
        }
        p.blank = false;
        p.letter = rackTile;
      }
    }

    const result = game.validateAndScore(room.state, placements, dictionary);
    if (!result.ok) return ack && ack({ ok: false, reason: result.reason });
    game.applyMove(room.state, placements, result);
    ack && ack({ ok: true, score: result.totalScore, words: result.words });
    broadcastRoom(room);

    // Fire-and-forget: fetch definitions for every word formed and broadcast them.
    const wordsFormed = result.words.map(w => w.word.toUpperCase());
    lookupWords(wordsFormed).then(defs => {
      const payload = {
        player: room.state.lastMove.player,
        playerName: room.players[room.state.lastMove.player].name,
        score: result.totalScore,
        moveNumber: room.state.moveNumber,
        words: defs
      };
      const withDef = defs.filter(d => d.def).length;
      console.log(`[defs] room=${room.code} words=[${wordsFormed.join(',')}] withDef=${withDef}/${defs.length}`);
      for (const p of room.players) {
        if (p.socketId) io.to(p.socketId).emit('definitions', payload);
      }
    }).catch((e) => { console.error('[defs] lookup failed:', e.message); });
  });

  socket.on('pass', (_data, ack) => {
    if (!joinedRoom) return ack && ack({ ok: false, reason: 'No room' });
    const room = rooms.get(joinedRoom);
    if (!room || !room.state) return ack && ack({ ok: false, reason: 'No game' });
    const me = findPlayerIndex(room, socket.id);
    if (me !== room.state.turn) return ack && ack({ ok: false, reason: 'Not your turn' });
    game.passTurn(room.state);
    ack && ack({ ok: true });
    broadcastRoom(room);
  });

  socket.on('exchange', ({ rackIndices }, ack) => {
    if (!joinedRoom) return ack && ack({ ok: false, reason: 'No room' });
    const room = rooms.get(joinedRoom);
    if (!room || !room.state) return ack && ack({ ok: false, reason: 'No game' });
    const me = findPlayerIndex(room, socket.id);
    if (me !== room.state.turn) return ack && ack({ ok: false, reason: 'Not your turn' });
    const result = game.exchangeTiles(room.state, rackIndices);
    if (!result.ok) return ack && ack(result);
    ack && ack({ ok: true });
    broadcastRoom(room);
  });

  socket.on('chat', ({ text }) => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const me = findPlayerIndex(room, socket.id);
    if (me < 0) return;
    const msg = {
      from: room.players[me].name,
      text: String(text || '').slice(0, 200),
      at: Date.now()
    };
    for (const p of room.players) io.to(p.socketId).emit('chat', msg);
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const idx = findPlayerIndex(room, socket.id);
    if (idx < 0) return;
    if (!room.state) {
      // Pre-game: remove the player so room can still be filled
      room.players.splice(idx, 1);
      if (room.players.length === 0) rooms.delete(room.code);
      else broadcastRoom(room);
    } else {
      // Mid-game: keep slot, mark disconnected; allow re-join via the same code+name
      room.players[idx].socketId = null;
      // Notify the other player
      for (const p of room.players) {
        if (p.socketId) io.to(p.socketId).emit('peer-disconnected', { who: idx });
      }
      // Clean up empty rooms after 30 minutes
      setTimeout(() => {
        if (rooms.get(room.code) === room && room.players.every(p => !p.socketId)) {
          rooms.delete(room.code);
        }
      }, 30 * 60 * 1000);
    }
  });

  // Allow rejoining a mid-game room (room must still exist and a slot must be vacant)
  socket.on('rejoin', ({ code, name }, ack) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, reason: 'Room not found' });
    const slot = room.players.findIndex(p => !p.socketId && p.name === (name || '').slice(0, 16));
    if (slot < 0) return ack && ack({ ok: false, reason: 'No matching slot' });
    room.players[slot].socketId = socket.id;
    joinedRoom = code;
    socket.join(code);
    ack && ack({ ok: true, code, you: slot });
    if (room.state) {
      io.to(socket.id).emit('state', game.publicView(room.state, slot));
    } else {
      broadcastRoom(room);
    }
    // Tell the other player that this player came back
    for (const p of room.players) {
      if (p.socketId && p.socketId !== socket.id) {
        io.to(p.socketId).emit('peer-rejoined', { who: slot, name: room.players[slot].name });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`elbbarcs running on http://localhost:${PORT}`);
});
