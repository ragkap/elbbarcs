'use strict';

// Persistence layer for rooms. Backed by Upstash Redis when
// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars are set;
// otherwise falls back to no-op so local dev / unconfigured deploys keep working.
//
// Key shape:
//   room:<code>   → JSON-encoded room object
//   rooms         → SET of all known room codes (for boot-time hydration)
//
// We don't try to coordinate concurrent writes — turn-based gameplay rarely
// produces overlapping writes, and last-writer-wins is acceptable.

const ROOM_TTL_SECONDS = 24 * 60 * 60; // 24h — long enough to revive a paused game,
                                       // short enough that abandoned rooms get cleaned up

let client = null;
let enabled = false;

function init() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.log('[store] Upstash not configured — running in memory-only mode.');
    return;
  }
  try {
    const { Redis } = require('@upstash/redis');
    client = new Redis({ url, token });
    enabled = true;
    console.log('[store] Upstash connected; rooms will persist across restarts.');
  } catch (e) {
    console.error('[store] Failed to initialize Upstash:', e.message);
  }
}

// Serializable shape of a room. socketIds are transient (sockets won't survive
// a server restart anyway), so we drop them at save time and assume null on load —
// players will re-attach via rejoin on reconnect.
function serializeRoom(room) {
  return JSON.stringify({
    code: room.code,
    players: room.players.map(p => ({ id: p.id, name: p.name, socketId: null })),
    state: room.state,
    createdAt: room.createdAt
  });
}

function deserializeRoom(json) {
  if (!json) return null;
  const r = typeof json === 'string' ? JSON.parse(json) : json;
  // Ensure socketId is null (will be re-populated when players reconnect).
  if (r.players) {
    for (const p of r.players) p.socketId = null;
  }
  return r;
}

async function saveRoom(room) {
  if (!enabled || !room) return;
  try {
    await client.set(`room:${room.code}`, serializeRoom(room), { ex: ROOM_TTL_SECONDS });
    await client.sadd('rooms', room.code);
    // Refresh the set's TTL so it doesn't pile up forever
    await client.expire('rooms', ROOM_TTL_SECONDS * 2);
  } catch (e) {
    console.error(`[store] saveRoom(${room.code}) failed:`, e.message);
  }
}

async function deleteRoom(code) {
  if (!enabled) return;
  try {
    await client.del(`room:${code}`);
    await client.srem('rooms', code);
  } catch (e) {
    console.error(`[store] deleteRoom(${code}) failed:`, e.message);
  }
}

async function loadAllRooms() {
  if (!enabled) return [];
  try {
    const codes = await client.smembers('rooms');
    if (!codes || codes.length === 0) return [];
    const results = [];
    for (const code of codes) {
      const json = await client.get(`room:${code}`);
      const room = deserializeRoom(json);
      if (room) {
        results.push(room);
      } else {
        // Key expired but still in the set — clean up.
        await client.srem('rooms', code);
      }
    }
    return results;
  } catch (e) {
    console.error('[store] loadAllRooms failed:', e.message);
    return [];
  }
}

module.exports = {
  init,
  saveRoom,
  deleteRoom,
  loadAllRooms,
  isEnabled: () => enabled
};
