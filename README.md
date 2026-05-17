# elbbarcs

Two-player online Scrabble for phones (`elbbarcs` = `scrabble` reversed).

## Run

```
npm install
npm start
```

Open `http://<your-machine>:3000` on each phone. One player taps **Create new game**, shares the 4-letter code, the other taps **Join game**. Player 1 hits **Start game**.

To play on two phones over the internet, expose port 3000 with a tunnel:

```
ngrok http 3000     # or: cloudflared tunnel --url http://localhost:3000
```

Set `PORT=...` to change the listening port.

## Persistence (optional)

Games are stored in server memory by default — if the server restarts, in-progress rooms are lost. To survive restarts and Railway deploys, point the server at an [Upstash](https://upstash.com) Redis database (free tier is plenty):

1. Sign up at upstash.com, create a new Redis database.
2. Copy the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` values.
3. Set them as env vars on the server (Railway → service → Variables, or `.env` locally).

When these are set, rooms persist to Redis with a 24-hour TTL and are hydrated on server boot. With them unset, the server falls back to memory-only mode (current behavior).

## Playing

- Drag tiles from your rack onto the board to compose a word.
- Tap a placed (pending) tile to recall it.
- **Recall** returns all pending tiles. **Shuffle** reorders your rack. **Exchange** swaps tiles back into the bag (only when the bag has ≥ 7 tiles). **Pass** skips your turn. **Play** submits.
- First word must cross the center star and be at least 2 letters.
- Subsequent words must connect to existing tiles.
- Blank tiles open a letter picker.
- All formed words must appear in the dictionary (TWL/SOWPODS-style English).
- 50-point bingo bonus for using all 7 tiles.
- Game ends when one player empties their rack with an empty bag, or after six consecutive passes/exchanges.

## Files

- `server.js` — Express + Socket.IO server, room and turn management.
- `game.js` — Pure game logic: board, tile bag, validation, scoring.
- `words.txt` — Dictionary (~178k words).
- `public/` — Mobile-first frontend (no build step).
- `test.js`, `test-e2e.js` — Smoke tests (`node test.js` and `node test-e2e.js` with the server running on port 3030).
# elbbarcs
