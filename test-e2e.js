'use strict';
const { io } = require('socket.io-client');

const URL = 'http://localhost:3030';

(async () => {
  const a = io(URL, { transports: ['websocket'] });
  const b = io(URL, { transports: ['websocket'] });

  function nextEvent(sock, ev, predicate) {
    return new Promise(r => {
      const h = (data) => {
        if (!predicate || predicate(data)) {
          sock.off(ev, h);
          r(data);
        }
      };
      sock.on(ev, h);
    });
  }
  function emit(sock, ev, data) {
    return new Promise(r => sock.emit(ev, data, r));
  }
  function once(sock, ev) { return new Promise(r => sock.once(ev, r)); }

  await Promise.all([once(a, 'connect'), once(b, 'connect')]);

  // Pre-register A's lobby listener so we capture the post-join broadcast
  const aLobbyWith2 = nextEvent(a, 'lobby', l => l.players.length === 2);

  const created = await emit(a, 'create', { name: 'Alice' });
  if (!created.ok) throw new Error('create failed: ' + created.reason);
  console.log('created room', created.code);

  const joined = await emit(b, 'join', { name: 'Bob', code: created.code });
  if (!joined.ok) throw new Error('join failed: ' + joined.reason);
  console.log('joined as', joined.you);

  await aLobbyWith2;
  console.log('lobby has 2 players');

  // Pre-register state listeners before starting
  const aState = once(a, 'state');
  const bState = once(b, 'state');

  const started = await emit(a, 'start', {});
  if (!started.ok) throw new Error('start failed: ' + started.reason);

  const sA = await aState;
  const sB = await bState;
  console.log('A rack:', sA.rack, 'turn=', sA.turn, 'you=', sA.you);
  console.log('B rack:', sB.rack, 'turn=', sB.turn, 'you=', sB.you);

  const moverSocket = sA.turn === 0 ? a : b;
  const moverView = sA.turn === 0 ? sA : sB;
  const rack = moverView.rack.slice();

  // Look for a 2-letter word using two distinct rack positions
  const valid2 = ['AA','AB','AD','AE','AG','AH','AI','AL','AM','AN','AR','AS','AT','AW','AX','AY','BA','BE','BI','BO','BY','DE','DO','EH','EL','EM','EN','ER','ES','ET','EX','FA','FE','GO','HA','HE','HI','HM','HO','ID','IF','IN','IS','IT','JO','KA','KI','LA','LI','LO','MA','ME','MI','MM','MO','MU','MY','NA','NE','NO','NU','OD','OE','OF','OH','OI','OK','OM','ON','OP','OR','OS','OW','OX','OY','PA','PE','PI','QI','RE','SH','SI','SO','TA','TI','TO','UH','UM','UN','UP','UR','US','UT','WE','WO','XI','XU','YA','YE','YO','ZA'];
  let placement = null;
  for (const w of valid2) {
    const a1 = w[0], a2 = w[1];
    const i1 = rack.indexOf(a1);
    if (i1 < 0) continue;
    const tmp = rack.slice(); tmp[i1] = '*';
    const i2 = tmp.indexOf(a2);
    if (i2 < 0) continue;
    placement = [
      { row: 7, col: 7, letter: a1, rackIndex: i1 },
      { row: 7, col: 8, letter: a2, rackIndex: i2 }
    ];
    console.log('attempting', w);
    break;
  }

  const otherSocket = moverSocket === a ? b : a;
  const otherStateAfter = once(otherSocket, 'state');

  if (!placement) {
    console.log('no 2-letter play; passing');
    const pres = await emit(moverSocket, 'pass', {});
    if (!pres.ok) throw new Error('pass failed: ' + pres.reason);
  } else {
    const mres = await emit(moverSocket, 'move', { placements: placement });
    if (!mres.ok) throw new Error('move failed: ' + mres.reason);
    console.log('move accepted score=', mres.score, 'words=', mres.words.map(w => w.word));
  }

  const after = await otherStateAfter;
  console.log('opponent state scores=', after.scores, 'turn=', after.turn, 'lastMove=', after.lastMove?.type);

  a.disconnect(); b.disconnect();
  console.log('\nE2E PASSED');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
