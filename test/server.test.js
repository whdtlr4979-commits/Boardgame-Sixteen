'use strict';
process.env.BOT_DELAY_MS = '5';
const test = require('node:test');
const assert = require('node:assert');
const { io: Client } = require('socket.io-client');
const { server, io } = require('../server');

function connect(port) {
  const s = Client(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
  s.call = (ev, p = {}) => new Promise((r) => s.emit(ev, p, r));
  s.nextRoom = (pred = () => true) => new Promise((r) => {
    const h = (room) => { if (pred(room)) { s.off('room', h); r(room); } };
    s.on('room', h);
  });
  return new Promise((r) => s.on('connect', () => r(s)));
}

test('두 명이 방을 만들고 참가해 게임을 진행한다', { timeout: 30000 }, async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const a = await connect(port);
  const b = await connect(port);
  try {
    assert.ok((await a.call('hello', { name: '앨리스' })).ok);
    assert.ok((await b.call('hello', { name: '밥' })).ok);
    const bad = await a.call('game:start');
    assert.strictEqual(bad.ok, false);

    const { code } = await a.call('room:create', { name: '테스트', maxPlayers: 3, rounds: 1 });
    assert.ok(code);
    assert.ok((await b.call('room:join', { code })).ok);
    assert.strictEqual((await b.call('game:start')).ok, false, '방장만 시작 가능');
    assert.ok((await a.call('room:addBot')).ok);

    const started = a.nextRoom((r) => r.game);
    assert.ok((await a.call('game:start')).ok);
    let room = await started;
    assert.strictEqual(room.game.players.length, 3);
    assert.strictEqual(room.game.hand.length, 16);

    // 끝날 때까지 사람은 가능한 가장 낮은 싱글/패스로 플레이
    const done = new Promise((resolve) => {
      for (const s of [a, b]) {
        s.on('room', async (r) => {
          const g = r.game;
          if (!g) return;
          if (g.phase === 'finished') return resolve(r);
          if (g.phase !== 'playing') return;
          const seat = g.players.findIndex((p) => p.id === r.you);
          if (g.current !== seat) return;
          const turn = g.turnId;
          if (s.lastTurn === turn) return;
          s.lastTurn = turn;
          if (!g.table) await s.call('game:play', { tileIds: [g.hand[0].id] });
          else {
            const t = g.table.combo;
            const pick = t.type === 'single' && g.hand.find((x) => (x.n || 16) > t.value);
            if (pick) await s.call('game:play', { tileIds: [pick.id] });
            else await s.call('game:pass');
          }
        });
      }
    });
    // 핸들러를 붙인 뒤 이벤트를 발생시켜 첫 차례를 놓치지 않게 한다.
    assert.ok((await b.call('chat:send', { text: '안녕!' })).ok);
    room = await done;
    assert.strictEqual(room.game.phase, 'finished');
    assert.ok(room.chat.some((m) => m.text === '안녕!'));
    assert.strictEqual(room.game.standings.length, 3);
  } finally {
    a.close();
    b.close();
    io.close();
    server.close();
  }
});
