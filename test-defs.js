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
  const aLobby2 = nextEvent(a, 'lobby', l => l.players.length === 2);

  const created = await emit(a, 'create', { name: 'Alice' });
  const joined = await emit(b, 'join', { code: created.code, name: 'Bob' });
  if (!created.ok || !joined.ok) throw new Error('setup');
  await aLobby2;

  const aState = once(a, 'state');
  const bState = once(b, 'state');
  await emit(a, 'start', {});
  const sA = await aState;
  await bState;

  const moverSock = sA.turn === 0 ? a : b;
  const moverView = sA.turn === 0 ? sA : { rack: (await emit(b, 'noop', {})).rack };
  const rack = sA.rack;
  console.log('rack:', rack);

  // Look for an easy 2-letter word
  const valid2 = ['AA','AE','AI','AL','AM','AN','AS','AT','BA','BE','BI','DE','DO','EH','EL','EM','EN','ER','ES','ET','FA','FE','GO','HA','HE','HI','IF','IN','IS','IT','KA','KI','LA','LI','LO','MA','ME','MI','MO','MU','MY','NA','NE','NO','NU','OD','OE','OF','OH','OI','OK','OM','ON','OP','OR','OS','OW','OX','OY','PA','PE','PI','QI','RE','SH','SI','SO','TA','TI','TO','UH','UM','UN','UP','UR','US','UT','WE','WO','XI','XU','YA','YE','YO','ZA'];
  let placement = null;
  for (const w of valid2) {
    const i1 = rack.indexOf(w[0]); if (i1 < 0) continue;
    const tmp = rack.slice(); tmp[i1] = '*';
    const i2 = tmp.indexOf(w[1]); if (i2 < 0) continue;
    placement = [
      { row: 7, col: 7, letter: w[0], rackIndex: i1 },
      { row: 7, col: 8, letter: w[1], rackIndex: i2 }
    ];
    console.log('will play:', w);
    break;
  }
  if (!placement) { console.log('no 2-letter word in rack — skipping'); process.exit(0); }

  const defsOnA = nextEvent(a, 'definitions');
  const defsOnB = nextEvent(b, 'definitions');

  const res = await emit(moverSock === a ? a : b, 'move', { placements: placement });
  console.log('move:', res.ok ? 'ok score=' + res.score : 'fail: ' + res.reason);

  const dA = await Promise.race([defsOnA, new Promise(r => setTimeout(() => r(null), 6000))]);
  const dB = await Promise.race([defsOnB, new Promise(r => setTimeout(() => r(null), 6000))]);

  console.log('A got definitions:', dA ? JSON.stringify(dA, null, 2) : '(timeout)');
  console.log('B got definitions:', dB ? 'yes' : '(timeout)');

  a.disconnect(); b.disconnect();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
