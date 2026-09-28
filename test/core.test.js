import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore, UserError, STALL_MS } from '../supabase/functions/_shared/core.js';
import { createMemoryDb } from './memory-db.js';

const A = { name: '앨리스', avatar: '🦊' };
const B = { name: '밥', avatar: '🐼' };

function setup() {
  const db = createMemoryDb();
  let clock = 1_000_000;
  const core = createCore(db, { botDelay: 0, sleep: async () => {}, now: () => clock });
  const call = async (user, action, payload = {}) => {
    const res = await core.handle(user, action, payload);
    if (res.runBots && res.code) await core.runBots(res.code);
    return res;
  };
  return { db, core, call, tick: (ms) => (clock += ms) };
}

test('방 만들기 → 참가 → 방장 권한 확인', async () => {
  const { db, call } = setup();
  const { code } = await call('u1', 'create', { profile: A, name: '테스트', maxPlayers: 3, rounds: 1 });
  assert.match(code, /^[0-9A-F]{6}$/);
  await call('u2', 'join', { profile: B, code: code.toLowerCase() });
  const room = await db.getRoom(code);
  assert.equal(room.members.length, 2);
  assert.equal(room.host_id, 'u1');
  await assert.rejects(call('u2', 'addBot'), /방장만/);
  await assert.rejects(call('u2', 'start'), /방장만/);
  await assert.rejects(call('u3', 'join', { profile: { name: '' }, code }), /닉네임/);
  await assert.rejects(call('u1', 'nope'), UserError);
});

test('정원 초과와 진행 중 참가를 막는다', async () => {
  const { call } = setup();
  const { code } = await call('u1', 'create', { profile: A, maxPlayers: 2 });
  await call('u2', 'join', { profile: B, code });
  await assert.rejects(call('u3', 'join', { profile: B, code }), /가득/);
});

test('손패는 사람에게만 저장되고 공개 상태에는 없다', async () => {
  const { db, call } = setup();
  const { code } = await call('u1', 'create', { profile: A, rounds: 1 });
  await call('u2', 'join', { profile: B, code });
  await call('u1', 'addBot');
  await call('u1', 'start');
  const view = db.games.get(code).view;
  assert.equal(view.players.length, 3);
  assert.ok(view.players.every((p) => p.hand === undefined));
  const handRows = [...db.hands.values()];
  assert.equal(handRows.length, 2, '봇의 손패는 hands 테이블에 없음');
  assert.deepEqual(handRows.map((h) => h.userId).sort(), ['u1', 'u2']);
  assert.equal((await db.getRoom(code)).status, 'playing');
});

test('사람 1명 + 봇 3명으로 게임을 끝까지 진행한다', async () => {
  const { db, call } = setup();
  const { code } = await call('u1', 'create', { profile: A, rounds: 2, maxPlayers: 4 });
  for (let i = 0; i < 3; i++) await call('u1', 'addBot');
  await call('u1', 'start');
  for (let steps = 0; steps < 2000; steps++) {
    const view = db.games.get(code).view;
    if (view.phase === 'finished') break;
    if (view.phase === 'roundEnd') { await call('u1', 'next'); continue; }
    const me = view.players[view.current];
    assert.equal(me.isBot, false, '봇 차례는 runBots 가 모두 처리해야 함');
    const hand = [...db.hands.values()].find((h) => h.userId === 'u1').tiles;
    if (view.table) await call('u1', 'pass');
    else await call('u1', 'play', { tileIds: [hand[0].id] });
  }
  const view = db.games.get(code).view;
  assert.equal(view.phase, 'finished');
  assert.equal(view.standings.length, 4);
  assert.equal((await db.getRoom(code)).status, 'finished');

  await call('u1', 'reset');
  assert.equal((await db.getRoom(code)).status, 'waiting');
  assert.equal(db.games.has(code), false);
});

test('규칙 위반은 사용자 오류로 전달되고 상태가 바뀌지 않는다', async () => {
  const { db, call } = setup();
  const { code } = await call('u1', 'create', { profile: A });
  await call('u2', 'join', { profile: B, code });
  await call('u1', 'start');
  const view = db.games.get(code).view;
  const turnUser = view.players[view.current].id === (await db.getRoom(code)).members[0].id ? 'u1' : 'u2';
  const other = turnUser === 'u1' ? 'u2' : 'u1';
  const before = db.secrets.get(code).version;
  await assert.rejects(call(other, 'pass'), /차례가 아닙니다/);
  await assert.rejects(call(turnUser, 'pass'), /패스할 수 없습니다/);
  await assert.rejects(call(turnUser, 'play', { tileIds: [99999] }), /손에 없는/);
  assert.equal(db.secrets.get(code).version, before);
});

test('게임 중 나가면 봇으로 대체되고, 다시 접속하면 자리를 되찾는다', async () => {
  const { db, call } = setup();
  const { code } = await call('u1', 'create', { profile: A, rounds: 3 });
  await call('u2', 'join', { profile: B, code });
  await call('u1', 'start');
  await call('u2', 'leave');
  let room = await db.getRoom(code);
  const seat = room.members.find((m) => m.formerUserId === 'u2');
  assert.ok(seat.isBot && seat.replaced);
  // u2 의 자리가 봇이 되었으므로 이제 u1 차례이거나 봇이 이미 진행함
  assert.equal(db.games.get(code).view.players.find((p) => p.id === seat.id).isBot, true);
  assert.equal([...db.hands.values()].some((h) => h.userId === 'u2'), false);

  const res = await call('u2', 'resume', { profile: B });
  assert.equal(res.code, code);
  assert.equal(res.reclaimed, true);
  room = await db.getRoom(code);
  const back = room.members.find((m) => m.id === seat.id);
  assert.equal(back.userId, 'u2');
  assert.equal(back.isBot, false);
  assert.ok([...db.hands.values()].some((h) => h.userId === 'u2'));
});

test('마지막 사람이 나가면 방이 삭제되고, 방장이 나가면 위임된다', async () => {
  const { db, call } = setup();
  const { code } = await call('u1', 'create', { profile: A });
  await call('u2', 'join', { profile: B, code });
  await call('u1', 'leave');
  assert.equal((await db.getRoom(code)).host_id, 'u2');
  await call('u2', 'leave');
  assert.equal(await db.getRoom(code), null);
});

test('응답 없는 플레이어는 일정 시간 후 봇으로 대체할 수 있다', async () => {
  const { db, call, tick } = setup();
  const { code } = await call('u1', 'create', { profile: A });
  await call('u2', 'join', { profile: B, code });
  await call('u1', 'start');
  const room = await db.getRoom(code);
  const view = db.games.get(code).view;
  const currentId = view.players[view.current].id;
  const waiter = room.members.find((m) => m.id !== currentId).userId;
  await assert.rejects(call(waiter, 'replace', { id: currentId }), /초 후에/);
  tick(STALL_MS + 1);
  await call(waiter, 'replace', { id: currentId });
  assert.equal((await db.getRoom(code)).members.find((m) => m.id === currentId).isBot, true);
  // 봇이 차례를 진행해 이제 대기하던 사람 차례
  const v2 = db.games.get(code).view;
  assert.equal(v2.players[v2.current].isBot, false);
});

test('채팅은 멤버 이름으로 기록된다', async () => {
  const { db, call } = setup();
  await call('u1', 'create', { profile: A });
  await call('u1', 'chat', { text: '  안녕 <b>  ' });
  const msg = db.messages.find((m) => !m.system);
  assert.equal(msg.name, '앨리스');
  assert.equal(msg.text, '안녕 b');
  await assert.rejects(call('u9', 'chat', { text: 'hi' }), /참여 중인 방이 없습니다/);
});
