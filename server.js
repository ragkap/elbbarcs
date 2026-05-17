'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');

const game = require('./game');
const og = require('./og');
const store = require('./store');
store.init();

const PORT = process.env.PORT || 3000;

// Load dictionary
const dictionary = new Set();
function loadWordsFrom(file) {
  const full = path.join(__dirname, file);
  if (!fs.existsSync(full)) return 0;
  let added = 0;
  for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
    const w = line.trim().toUpperCase();
    if (w && !dictionary.has(w)) { dictionary.add(w); added++; }
  }
  return added;
}
loadWordsFrom('words.txt');
const extra = loadWordsFrom('words-extra.txt');
console.log(`Loaded ${dictionary.size} dictionary words (${extra} extras).`);

const app = express();
app.use(compression());
// Trust the reverse-proxy (Railway edge) so req.protocol reflects the actual
// scheme the client used, not the internal http hop. Without this, OG image
// URLs come out http:// and most social previewers refuse mixed content.
app.set('trust proxy', true);

// Block search engines on HTML pages — but NOT on the OG image endpoints,
// since social-media preview scrapers (Slack/Facebook/LinkedIn) treat strict
// X-Robots-Tag values as a signal to skip the image entirely.
const OG_IMAGE_PATHS = new Set(['/og.png']);
app.use((req, res, next) => {
  const isOgImage = OG_IMAGE_PATHS.has(req.path) || req.path.startsWith('/og/');
  if (!isOgImage) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  }
  next();
});

// --- Open Graph / Twitter card images ---
// Cache rendered PNGs in memory so messengers (which hit the URL multiple times)
// don't trigger repeated SVG → PNG renders.
const ogCache = new Map();
const OG_CACHE_LIMIT = 200;

function ogCacheGet(key) { return ogCache.get(key); }
function ogCacheSet(key, buf) {
  if (ogCache.size >= OG_CACHE_LIMIT) ogCache.delete(ogCache.keys().next().value);
  ogCache.set(key, buf);
}

function sendPng(res, buf) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.end(buf);
}

app.get('/og.png', (req, res) => {
  try {
    let buf = ogCacheGet('home');
    if (!buf) {
      buf = og.renderPNG(og.homepageOG());
      ogCacheSet('home', buf);
    }
    sendPng(res, buf);
  } catch (e) {
    console.error('og home render failed:', e.message);
    res.status(500).end();
  }
});

app.get('/og/invite.png', (req, res) => {
  try {
    const code = (req.query.room || '').toString().toUpperCase().slice(0, 4);
    const room = code && rooms.get(code);
    const inviterName = (room && room.players[0] && room.players[0].name) || 'A friend';
    const key = `invite:${code}:${inviterName}`;
    let buf = ogCacheGet(key);
    if (!buf) {
      buf = og.renderPNG(og.inviteOG(inviterName, code));
      ogCacheSet(key, buf);
    }
    sendPng(res, buf);
  } catch (e) {
    console.error('og invite render failed:', e.message);
    res.status(500).end();
  }
});

// --- Root: serve index.html with OG tags rewritten for invite vs homepage ---
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
let _indexHtmlCache = null;
function indexHtml() {
  if (!_indexHtmlCache) _indexHtmlCache = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  return _indexHtmlCache;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

function ogTags({ title, description, imageUrl }) {
  return `<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${escapeHtml(imageUrl)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />`;
}

app.get('/', (req, res) => {
  const room = (req.query.room || '').toString().toUpperCase().slice(0, 4);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  let tags;
  if (room) {
    const r = rooms.get(room);
    const inviter = (r && r.players[0] && r.players[0].name) || 'A friend';
    tags = ogTags({
      title: `${inviter} invited you to elbbarcs`,
      description: `Tap to join room ${room}.`,
      imageUrl: `${baseUrl}/og/invite.png?room=${encodeURIComponent(room)}`
    });
  } else {
    tags = ogTags({
      title: 'elbbarcs',
      description: 'two players · one phone · love for words',
      imageUrl: `${baseUrl}/og.png`
    });
  }
  const html = indexHtml().replace(
    /<!--OG_TAGS_START-->[\s\S]*?<!--OG_TAGS_END-->/,
    `<!--OG_TAGS_START-->\n${tags}\n<!--OG_TAGS_END-->`
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, words: dictionary.size }));

// Expose the word list to the client (compressed by middleware above).
// Used to validate words client-side for live projected-score display.
app.get('/words.txt', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'words.txt'));
});
app.get('/words-extra.txt', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'words-extra.txt'));
});

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
const io = new Server(server, {
  cors: { origin: '*' },
  // Be patient with mobile clients: phones aggressively suspend background tabs,
  // so default 20s timeouts cause unnecessary disconnects on every screen-lock.
  pingInterval: 25000,
  pingTimeout: 60000,
  // Allow both transports so flaky networks can fall back from websocket to polling
  // without the user noticing.
  transports: ['websocket', 'polling']
});

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
  // Persist on every meaningful change. Fire-and-forget — failure is logged,
  // we don't block the broadcast on a network roundtrip to Upstash.
  store.saveRoom(room);

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
    const safeName = (name || 'Player 2').slice(0, 16);

    // If a vacant slot exists with the same name, treat this as a reconnect
    // (mobile tab-switch, network blip, etc.)
    const vacantSameName = room.players.findIndex(p => !p.socketId && p.name === safeName);
    if (vacantSameName >= 0) {
      room.players[vacantSameName].socketId = socket.id;
      joinedRoom = code;
      socket.join(code);
      ack && ack({ ok: true, code, you: vacantSameName });
      broadcastRoom(room);
      return;
    }

    // If a vacant slot exists (different name), take it
    const vacantAny = room.players.findIndex(p => !p.socketId);
    if (vacantAny >= 0) {
      playerId = socket.id + '-' + Date.now();
      room.players[vacantAny] = { id: playerId, name: safeName, socketId: socket.id };
      joinedRoom = code;
      socket.join(code);
      ack && ack({ ok: true, code, you: vacantAny });
      broadcastRoom(room);
      return;
    }

    if (room.players.length >= 2) return ack && ack({ ok: false, reason: 'Room full' });
    playerId = socket.id + '-' + Date.now();
    room.players.push({ id: playerId, name: safeName, socketId: socket.id });
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

    // Match each placement to a tile in the player's rack by letter (or blank).
    // We resolve rackIndex server-side so client-side rack reordering (shuffle) doesn't
    // desync — the client just tells us "this is the letter I want to play, and I think
    // it's at index N". If index N has the right letter we use it; otherwise we search.
    const rack = room.state.racks[me];
    const consumed = new Set();
    for (const p of placements) {
      const wantLetter = (p.letter || '').toUpperCase();
      if (!/^[A-Z]$/.test(wantLetter)) {
        return ack && ack({ ok: false, reason: 'Bad letter' });
      }

      // What kind of tile to look for: a blank if client said so, else a letter tile.
      const targetTile = p.blank ? '_' : wantLetter;

      // 1. Try the rackIndex the client suggested
      let idx = -1;
      if (typeof p.rackIndex === 'number' && p.rackIndex >= 0 && p.rackIndex < rack.length && !consumed.has(p.rackIndex)) {
        if (rack[p.rackIndex] === targetTile) idx = p.rackIndex;
      }

      // 2. Otherwise, find any matching tile in the rack (shuffle made the index stale)
      if (idx < 0) {
        for (let i = 0; i < rack.length; i++) {
          if (consumed.has(i)) continue;
          if (rack[i] === targetTile) { idx = i; break; }
        }
      }

      if (idx < 0) {
        return ack && ack({ ok: false, reason: p.blank ? 'No blank in rack' : `No ${wantLetter} in rack` });
      }

      consumed.add(idx);
      p.rackIndex = idx;
      p.blank = (rack[idx] === '_');
      p.letter = wantLetter;
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
      // Pre-game: keep the slot but mark socket as null so the host can come back
      // (e.g. mobile tab switch, network blip, refresh after sharing the link).
      // Clean up the room only if no one reconnects within 5 minutes.
      room.players[idx].socketId = null;
      // If everyone has dropped, schedule a cleanup
      if (room.players.every(p => !p.socketId)) {
        setTimeout(() => {
          if (rooms.get(room.code) === room && room.players.every(p => !p.socketId)) {
            rooms.delete(room.code);
            store.deleteRoom(room.code);
            console.log(`[room] cleaned up idle pre-game room ${room.code}`);
          }
        }, 5 * 60 * 1000);
      } else {
        broadcastRoom(room);
      }
    } else {
      // Mid-game: keep slot, mark disconnected; allow re-join via the same code+name
      room.players[idx].socketId = null;
      store.saveRoom(room);
      // Notify the other player
      for (const p of room.players) {
        if (p.socketId) io.to(p.socketId).emit('peer-disconnected', { who: idx });
      }
      // Don't auto-clean mid-game rooms — let Upstash TTL (24h) handle it so
      // players who disconnect overnight can pick up where they left off.
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

// Hydrate persisted rooms before we accept connections. Best-effort: if Upstash
// is misconfigured or unreachable, log and start with an empty room map.
(async () => {
  try {
    const persisted = await store.loadAllRooms();
    for (const room of persisted) {
      rooms.set(room.code, room);
    }
    if (persisted.length) {
      console.log(`[store] Restored ${persisted.length} room(s) from Upstash.`);
    }
  } catch (e) {
    console.error('[store] Hydration failed:', e.message);
  }
  server.listen(PORT, () => {
    console.log(`elbbarcs running on http://localhost:${PORT}`);
  });
})();
