import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createDeck, validatePlay, legalMoves, hasLegalMove, rowTop, sortHand, SixteenGame, botMove, HAND_SIZE, COLORS,
} from '../supabase/functions/_shared/game.js';

let nextId = 1000;
const N = (c, n) => ({ id: nextId++, c, n, k: 'num' });
const R = (c) => ({ id: nextId++, c, n: 16, k: 'restart' });
const E = (c) => ({ id: nextId++, c, n: 16, k: 'end' });
const S = () => ({ id: nextId++, c: null, n: 0, k: 'scissors' });
const T = () => ({ id: nextId++, c: null, n: 0, k: 'trash' });
const rowsOf = (spec = {}) => COLORS.map((c) => ({ color: c, tiles: [N(c, 1), ...(spec[c] || [])] }));

function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

test('구성물: 5색 × (1~15 + RESTART + END) + 가위 2 + 쓰레기통 1 = 88개', () => {
  const d = createDeck();
  assert.equal(d.length, 88);
  assert.equal(new Set(d.map((t) => t.id)).size, 88);
  for (const c of COLORS) {
    const mine = d.filter((t) => t.c === c);
    assert.equal(mine.length, 17);
    assert.equal(mine.filter((t) => t.k === 'restart').length, 1);
    assert.equal(mine.filter((t) => t.k === 'end').length, 1);
  }
  assert.equal(d.filter((t) => t.k === 'scissors').length, 2);
  assert.equal(d.filter((t) => t.k === 'trash').length, 1);
});

test('준비: 인원별 배분(2인 30, 3인 29, 4인 22) 후 1 타일 5개로 줄 시작', () => {
  for (const n of [2, 3, 4]) {
    const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    const g = new SixteenGame(players, { rng: seeded(n) });
    assert.equal(g.rows.length, 5);
    for (const row of g.rows) {
      assert.equal(row.tiles.length, 1);
      assert.equal(row.tiles[0].n, 1);
      assert.equal(row.tiles[0].c, row.color);
    }
    const held = g.players.reduce((s, p) => s + p.hand.length, 0);
    const onesInHands = HAND_SIZE[n] * n - held;
    assert.ok(onesInHands >= 0 && onesInHands <= 5);
    assert.ok(g.players.every((p) => p.hand.every((t) => !(t.k === 'num' && t.n === 1))), '손에 1이 남으면 안 됨');
    assert.equal(held + g.unused.length + 5, 88, '모든 타일이 어딘가에 있어야 함');
  }
  assert.throws(() => new SixteenGame([{ id: 'a', name: 'A' }]), /2~4명/);
  assert.throws(() => new SixteenGame(Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, name: `${i}` }))), /2~4명/);
});

test('놓기: 같은 색 줄에 더 큰 숫자, 건너뛰기 가능, 여러 개는 연속된 숫자만', () => {
  const rows = rowsOf({ red: [N('red', 4)] });
  assert.equal(validatePlay(rows, [N('red', 10)]).ok, true, '건너뛰기 허용');
  assert.equal(validatePlay(rows, [N('red', 4)]).ok, false, '같은 숫자 불가');
  assert.equal(validatePlay(rows, [N('red', 3)]).ok, false, '더 작은 숫자 불가');
  assert.equal(validatePlay(rows, [N('red', 7), N('red', 5), N('red', 6)]).ok, true, '연속 런 (순서 무관)');
  assert.match(validatePlay(rows, [N('red', 5), N('red', 7)]).error, /연속/);
  assert.match(validatePlay(rows, [N('red', 5), N('blue', 6)]).error, /같은 색/);
  assert.match(validatePlay(rows, [N('red', 5)], 'blue').error, /같은 색 줄/);
  assert.equal(validatePlay(rows, [N('red', 14), N('red', 15), E('red')]).ok, true, '15 다음 16(END) 연속');
});

test('RESTART는 줄을 0으로 되돌리고, END는 줄을 닫는다', () => {
  const restarted = { color: 'red', tiles: [N('red', 1), N('red', 9), R('red')] };
  assert.equal(rowTop(restarted), 0);
  const rows = rowsOf();
  rows[0] = restarted;
  assert.equal(validatePlay(rows, [N('red', 2)]).ok, true, 'RESTART 뒤에는 작은 숫자도 가능');

  const ended = rowsOf({ blue: [N('blue', 3), E('blue')] });
  assert.match(validatePlay(ended, [N('blue', 9)]).error, /닫혔/);
});

test('가위는 마지막 타일 제거, 쓰레기통은 1만 남기고 비움 (게임 진행)', () => {
  const g = new SixteenGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rng: seeded(5) });
  g.current = 0;
  const [a] = g.players;
  const red = g.rows.find((r) => r.color === 'red');
  red.tiles.push(N('red', 5), N('red', 8), E('red'));
  const scissors = S();
  const trash = T();
  a.hand.push(scissors, trash);

  assert.throws(() => g.play('a', [scissors.id]), /줄을 고르세요/);
  assert.throws(() => g.play('a', [scissors.id], 'blue'), /1만 있는 줄/);
  g.play('a', [scissors.id], 'red');
  assert.deepEqual(red.tiles.map((t) => t.n), [1, 5, 8], 'END 가 잘려 줄이 다시 열림');
  assert.equal(g.discard.length, 2);

  g.current = 0;
  g.play('a', [trash.id], 'red');
  assert.deepEqual(red.tiles.map((t) => t.n), [1]);
  assert.equal(rowTop(red), 1);
});

test('패스는 놓을 수 있는 타일이 없을 때만 가능, 모두 패스하면 합이 적은 사람 승리', () => {
  const g = new SixteenGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rng: seeded(9) });
  // 모든 줄을 END 로 닫아 아무도 놓을 수 없게 만든다
  for (const r of g.rows) r.tiles.push(E(r.color));
  g.players[0].hand = [N('red', 9), N('blue', 2)];
  g.players[1].hand = [N('green', 3)];
  g.current = 0;
  assert.equal(hasLegalMove(g.rows, g.players[0].hand), false);
  g.pass('a');
  g.pass('b');
  assert.equal(g.phase, 'finished');
  assert.equal(g.lastRound.emptied, false);
  assert.equal(g.players[g.lastRound.winner].id, 'b');
  assert.deepEqual(g.standings().map((s) => [s.id, s.score]), [['b', 3], ['a', 11]]);

  const g2 = new SixteenGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rng: seeded(10) });
  g2.current = 0;
  g2.players[0].hand = [N('red', 9)];
  assert.throws(() => g2.pass('a'), /패스할 수 없습니다/);
  g2.play('a', g2.players[0].hand.map((t) => t.id));
  assert.equal(g2.phase, 'finished');
  assert.equal(g2.lastRound.emptied, true);
  assert.equal(g2.lastRound.winner, 0);
});

test('legalMoves 는 모든 런과 특수 타일 사용을 찾는다', () => {
  const rows = rowsOf({ green: [N('green', 6)] });
  const hand = [N('red', 2), N('red', 3), N('green', 5), N('green', 7), N('green', 8), S()];
  const moves = legalMoves(rows, hand);
  const key = (m) => `${m.row}:${m.tileIds.map((id) => hand.find((t) => t.id === id).n).join(',')}`;
  const keys = moves.map(key).sort();
  assert.deepEqual(keys, ['green:0', 'green:7', 'green:7,8', 'green:8', 'red:2', 'red:2,3', 'red:3'].sort());
  for (const m of moves) {
    const tiles = m.tileIds.map((id) => hand.find((t) => t.id === id));
    assert.equal(validatePlay(rows, tiles, m.row).ok, true, key(m));
  }
});

test('봇끼리 2~4인 게임을 끝까지 진행할 수 있다', () => {
  for (let s = 1; s <= 40; s++) {
    const n = 2 + (s % 3);
    const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: true }));
    const g = new SixteenGame(players, { rng: seeded(s) });
    let steps = 0;
    while (g.phase === 'playing') {
      const id = g.players[g.current].id;
      const m = botMove(g, id);
      if (m.action === 'play') g.play(id, m.tileIds, m.row);
      else g.pass(id);
      assert.ok(++steps < 1000, 'game should terminate');
    }
    assert.equal(g.phase, 'finished');
    const st = g.standings();
    assert.equal(st[0].id, g.players[g.lastRound.winner].id);
  }
});

test('viewFor 는 다른 사람의 손패를 숨긴다', () => {
  const g = new SixteenGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rng: seeded(3) });
  const v = g.viewFor('a');
  assert.ok(v.hand.length >= 25);
  assert.ok(v.players.every((p) => p.hand === undefined && typeof p.count === 'number'));
  assert.equal(v.rows.length, 5);
  assert.equal(JSON.stringify(v.players).includes('"hand"'), false);
});

test('toJSON/fromJSON 으로 저장했다 불러와도 게임이 이어진다', () => {
  const g = new SixteenGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rng: seeded(11) });
  const id = g.players[g.current].id;
  const m = botMove(g, id);
  g.play(id, m.tileIds, m.row);
  const restored = SixteenGame.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.deepEqual(restored.publicView(), g.publicView());
  assert.equal(restored.rng, Math.random);
  const next = restored.players[restored.current];
  const m2 = botMove(restored, next.id);
  if (m2.action === 'play') restored.play(next.id, m2.tileIds, m2.row);
  else restored.pass(next.id);
});

test('손패 정렬: 색깔별 오름차순, 가위·쓰레기통은 맨 뒤', () => {
  const sorted = sortHand([T(), N('blue', 3), E('red'), N('red', 9), S(), R('red'), N('red', 2)]);
  assert.deepEqual(sorted.map((t) => `${t.c}:${t.k}:${t.n}`), [
    'red:num:2', 'red:num:9', 'red:restart:16', 'red:end:16', 'blue:num:3', 'null:scissors:0', 'null:trash:0',
  ]);
});

test('public/game.js 는 엔진 원본과 동일하다 (npm run sync)', async () => {
  const src = await readFile(new URL('../supabase/functions/_shared/game.js', import.meta.url), 'utf8');
  const pub = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.equal(pub, src, 'npm run sync 를 실행하세요');
});
