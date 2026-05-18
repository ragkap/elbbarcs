'use strict';

// SVG OG image generator. Produces a 1200×630 SVG matching the app's visual
// language (dark green background, gold tile, Scrabble-style points).
// Used both for the homepage card and for room invite links.

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  }[ch]));
}

const W = 1200, H = 630;

const TILE_VALUES = { A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10 };

function tile(letter, x, y, size) {
  const pts = TILE_VALUES[letter.toUpperCase()] ?? 0;
  const fontMain = Math.round(size * 0.6);
  const fontPts = Math.round(size * 0.18);
  return `
    <g transform="translate(${x},${y})">
      <rect width="${size}" height="${size}" rx="${size * 0.08}" ry="${size * 0.08}"
            fill="#f1d899" stroke="#b08d4a" stroke-width="3"/>
      <text x="${size * 0.32}" y="${size * 0.7}" font-family="-apple-system, Helvetica, Arial, sans-serif"
            font-size="${fontMain}" font-weight="800" fill="#2a1d05">${escapeXml(letter.toUpperCase())}</text>
      <text x="${size * 0.72}" y="${size * 0.88}" font-family="-apple-system, Helvetica, Arial, sans-serif"
            font-size="${fontPts}" font-weight="700" fill="#2a1d05">${pts}</text>
    </g>`;
}

function wordRow(word, startX, y, size) {
  const gap = 8;
  let svg = '';
  for (let i = 0; i < word.length; i++) {
    svg += tile(word[i], startX + i * (size + gap), y, size);
  }
  return svg;
}

// --- Homepage card: shows the logo wordmark "ELBBARCS" as tiles + tagline ---
function homepageOG() {
  const tileSize = 110;
  const word = 'ELBBARCS';
  const gap = 8;
  const totalW = word.length * tileSize + (word.length - 1) * gap;
  const startX = (W - totalW) / 2;
  const tileY = 180;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#143524"/>
      <stop offset="1" stop-color="#0f1d14"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${wordRow(word, startX, tileY, tileSize)}
  <text x="${W / 2}" y="${tileY + tileSize + 80}" font-family="-apple-system, Helvetica, Arial, sans-serif"
        font-size="38" font-weight="500" fill="#b8c4ad" text-anchor="middle">
    two players · two phones · one love for words
  </text>
  <text x="${W / 2}" y="${tileY + tileSize + 140}" font-family="-apple-system, Helvetica, Arial, sans-serif"
        font-size="28" font-weight="400" fill="#f4c95d" text-anchor="middle" font-style="italic">
    a 2-player online word game
  </text>
</svg>`;
}

// --- Invite card: ELBBARCS spelled in tiles + inviter name in text ---
function inviteOG(inviterName, code) {
  const word = 'ELBBARCS';
  const tileSize = 110;
  const gap = 8;
  const totalW = word.length * tileSize + (word.length - 1) * gap;
  const startX = (W - totalW) / 2;
  const tileY = 130;

  const safeCode = escapeXml(String(code || '').toUpperCase().slice(0, 4));
  const displayName = escapeXml(inviterName || 'A friend');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#143524"/>
      <stop offset="1" stop-color="#0f1d14"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${wordRow(word, startX, tileY, tileSize)}
  <text x="${W / 2}" y="${tileY + tileSize + 90}" font-family="-apple-system, Helvetica, Arial, sans-serif"
        font-size="48" font-weight="700" fill="#f4ede0" text-anchor="middle">
    ${displayName} has invited you to play
  </text>
  <text x="${W / 2}" y="${tileY + tileSize + 160}" font-family="-apple-system, Helvetica, Arial, sans-serif"
        font-size="34" font-weight="500" fill="#f4c95d" text-anchor="middle">
    tap to join · room ${safeCode}
  </text>
</svg>`;
}

let resvg = null;
function getResvg() {
  if (!resvg) resvg = require('@resvg/resvg-js');
  return resvg;
}

function renderPNG(svg) {
  const { Resvg } = getResvg();
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: W } });
  return r.render().asPng();
}

module.exports = { homepageOG, inviteOG, renderPNG };
