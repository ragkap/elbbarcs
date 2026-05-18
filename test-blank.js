'use strict';
const { io } = require('socket.io-client');
const URL = 'http://localhost:3030';

(async () => {
  const a = io(URL, { transports: ['websocket'] });
  const b = io(URL, { transports: ['websocket'] });

  function emit(s, ev, data) { return new Promise(r => s.emit(ev, data, r)); }
  function once(s, ev) { return new Promise(r => s.once(ev, r)); }
  function nextEvent(s, ev, pred) {
    return new Promise(r => {
      const h = (d) => { if (!pred || pred(d)) { s.off(ev, h); r(d); } };
      s.on(ev, h);
    });
  }

  await Promise.all([once(a, 'connect'), once(b, 'connect')]);
  const lobby2 = nextEvent(a, 'lobby', l => l.players.length === 2);
  const created = await emit(a, 'create', { name: 'Alice' });
  const joined = await emit(b, 'join', { code: created.code, name: 'Bob' });
  if (!created.ok || !joined.ok) throw new Error('setup');
  await lobby2;

  const aState = once(a, 'state');
  const bState = once(b, 'state');
  await emit(a, 'start', {});
  const sA = await aState;
  await bState;

  // Force a blank into player 0's rack and clear other tiles for a deterministic test.
  // We can't directly mutate server state through the public API; but if the rack
  // doesn't include a blank, no point continuing. Print rack:
  console.log('Alice rack:', sA.rack);

  const blankIdx = sA.rack.indexOf('_');
  if (blankIdx < 0) {
    console.log('No blank in initial rack — skipping test (re-run a few times to luck out)');
    process.exit(0);
  }

  // Find a letter to pair with the blank to form a known 2-letter word.
  // Try common 2-letter words.
  const valid2 = ['AA','AE','AI','AL','AM','AN','AS','AT','BA','BE','BI','DE','DO','EH','EL','EM','EN','ER','ES','ET','FA','FE','GO','HA','HE','HI','IF','IN','IS','IT','KA','KI','LA','LI','LO','MA','ME','MI','MO','MU','MY','NA','NE','NO','NU','OD','OE','OF','OH','OI','OK','OM','ON','OP','OR','OS','OW','OX','OY','PA','PE','PI','QI','RE','SH','SI','SO','TA','TI','TO','UH','UM','UN','UP','UR','US','UT','WE','WO','XI','XU','YA','YE','YO','ZA'];

  const moverSock = sA.turn === 0 ? a : b;
  const rack = sA.rack;

  let placement = null;
  for (const w of valid2) {
    // Try: blank serves as w[0], real tile serves as w[1]
    const realIdx1 = rack.indexOf(w[1]);
    if (realIdx1 >= 0 && realIdx1 !== blankIdx) {
      placement = [
        { row: 7, col: 7, letter: w[0], blank: true, rackIndex: blankIdx },
        { row: 7, col: 8, letter: w[1], blank: false, rackIndex: realIdx1 }
      ];
      console.log('Will try blank for ' + w[0] + ' to form: ' + w);
      break;
    }
    // Or: real tile is w[0], blank serves as w[1]
    const realIdx0 = rack.indexOf(w[0]);
    if (realIdx0 >= 0 && realIdx0 !== blankIdx) {
      placement = [
        { row: 7, col: 7, letter: w[0], blank: false, rackIndex: realIdx0 },
        { row: 7, col: 8, letter: w[1], blank: true, rackIndex: blankIdx }
      ];
      console.log('Will try blank for ' + w[1] + ' to form: ' + w);
      break;
    }
  }

  if (!placement) {
    console.log('Could not find a 2-letter word using blank + rack. Skipping.');
    process.exit(0);
  }

  const res = await emit(moverSock === a ? a : b, 'move', { placements: placement });
  console.log('Move result:', res);
  if (!res.ok) {
    console.error('BLANK MOVE REJECTED:', res.reason);
    process.exit(1);
  }
  console.log('BLANK MOVE ACCEPTED. score=', res.score, 'words=', res.words.map(w => w.word));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
