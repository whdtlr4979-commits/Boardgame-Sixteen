import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  tilePenalty, createDeck, validatePlay, legalMoves, hasLegalMove, rowTop, sortHand, SixteenGame, botMove, HAND_SIZE, COLORS,
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

test('준비: 2인은 1을 먼저 꺼내고 30개씩, 3~4인은 1까지 나눠 각자 낸 뒤 빨강 1 주인부터', () => {
  for (let seed = 1; seed <= 30; seed++) {
    for (const n of [2, 3, 4]) {
      const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
      const g = new SixteenGame(players, { rng: seeded(seed * 7 + n) });
      const held = g.players.reduce((s, p) => s + p.hand.length, 0);
      const onTable = g.rows.reduce((s, r) => s + r.tiles.length, 0);
      assert.equal(held + onTable + g.unused.length, 88, '모든 타일이 어딘가에 있어야 함');
      assert.ok(g.players.every((p) => p.hand.every((t) => !(t.k === 'num' && t.n === 1))), '손에 1이 남으면 안 됨');
      for (const row of g.rows) {
        if (row.tiles.length) assert.deepEqual([row.tiles[0].n, row.tiles[0].c], [1, row.color]);
      }
      if (n === 2) {
        assert.ok(g.players.every((p) => p.hand.length === 30), '2인은 1을 빼고 30개씩');
        assert.ok(g.rows.every((r) => r.tiles.length === 1));
      }
      if (n === 4) {
        assert.equal(g.unused.length, 0, '4인은 88개 모두 배분');
        assert.ok(g.rows.every((r) => r.tiles.length === 1));
        assert.equal(held + 5, 88);
      }
      if (n === 3) {
        assert.equal(g.unused.length, 1, '3인은 1개가 상자에 남음');
        const missing = g.rows.filter((r) => !r.tiles.length).length;
        assert.equal(missing, g.unused[0].k === 'num' && g.unused[0].n === 1 ? 1 : 0);
      }
      if (n > 2 && g.rows[0].tiles.length) {
        // 빨강 1을 가지고 있던 사람이 시작 — 그 사람은 1을 내서 손패가 줄어들었다
        const dealt = 88 - g.unused.length;
        assert.equal(dealt / n, n === 3 ? 29 : 22);
        assert.match(g.log.map((l) => l.text).join('\n'), new RegExp(`빨강 1을 낸 ${g.players[g.current].name}님부터`));
      }
    }
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

test('RESTART는 줄을 1로 되돌리고, END는 줄을 닫는다', () => {
  const restarted = { color: 'red', tiles: [N('red', 1), N('red', 9), R('red')] };
  assert.equal(rowTop(restarted), 1);
  const rows = rowsOf();
  rows[0] = restarted;
  assert.equal(validatePlay(rows, [N('red', 2)]).ok, true, 'RESTART 뒤에는 작은 숫자도 가능');

  const ended = rowsOf({ blue: [N('blue', 3), E('blue')] });
  assert.match(validatePlay(ended, [N('blue', 9)]).error, /닫혔/);
  assert.match(validatePlay(ended, [R('blue')]).error, /닫혔/, 'END 뒤에는 RESTART 불가');
  assert.equal(validatePlay(rowsOf({ red: [R('red')] }), [E('red')]).ok, true, 'RESTART 뒤에 END 가능');
  assert.equal(validatePlay(rowsOf(), [N('red', 15), R('red'), E('red')]).ok, false, 'RESTART·END 동시 불가');
});

test('가위·쓰레기통: 제거 후 같은 사람이 숫자 타일을 한 번 더 놓는다', () => {
  const g = new SixteenGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rng: seeded(5) });
  g.current = 0;
  const [a] = g.players;
  const red = g.rows.find((r) => r.color === 'red');
  red.tiles.push(N('red', 5), N('red', 8), E('red'));
  const scissors = S();
  const trash = T();
  const red9 = N('red', 9);
  a.hand = [scissors, trash, red9, N('blue', 15), N('green', 15)];
  g.rows.find((r) => r.color === 'blue').tiles.push(E('blue'));
  g.rows.find((r) => r.color === 'green').tiles.push(E('green'));

  assert.throws(() => g.play('a', [scissors.id]), /줄을 고르세요/);
  assert.throws(() => g.play('a', [scissors.id], 'orange'), /1 타일만 있는 줄/);
  g.play('a', [scissors.id], 'red');
  assert.deepEqual(red.tiles.map((t) => t.n), [1, 5, 8], 'END 가 잘려 줄이 다시 열림');
  assert.equal(g.current, 0, '같은 사람 차례가 이어짐');
  assert.equal(g.bonus, true);
  assert.throws(() => g.play('a', [trash.id], 'red'), /숫자 타일만/, '추가 차례에는 숫자 타일만');
  g.play('a', [red9.id]);
  assert.equal(g.current, 1);
  assert.equal(g.bonus, false);

  // 쓰레기통: 원하는 개수만큼 (1 제외)
  g.current = 0;
  assert.deepEqual(red.tiles.map((t) => t.n), [1, 5, 8, 9]);
  assert.throws(() => g.play('a', [trash.id], 'red', 4), /1~3개/);
  g.play('a', [trash.id], 'red', 2);
  assert.deepEqual(red.tiles.map((t) => t.n), [1, 5]);
  assert.equal(g.bonus, true);
  // 남은 숫자 타일(파랑 15, 초록 15)은 닫힌 줄이라 놓을 수 없음 → 추가 차례만 넘김 (패스로 세지 않음)
  g.pass('a');
  assert.equal(g.current, 1);
  assert.equal(g.passes, 0);
});

test('점수: 남은 숫자 합 + 기능 타일 1개당 20점 (룰북 예시 3 + 가위 = 23)', () => {
  assert.equal(tilePenalty(S()), 20);
  assert.equal(tilePenalty(T()), 20);
  assert.equal(tilePenalty(E('red')), 16);
  const g = new SixteenGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rng: seeded(21) });
  for (const r of g.rows) r.tiles = [r.tiles[0], E(r.color)];
  g.players[0].hand = [N('green', 3), S()];
  g.players[1].hand = [N('red', 15)];
  g.current = 1;
  g.pass('b');
  assert.throws(() => g.pass('a'), /패스할 수 없습니다/, '가위를 쓸 수 있으면 반드시 사용');
  g.players[0].hand = [N('green', 3)];
  g.pass('a');
  assert.equal(g.phase, 'finished');
  assert.deepEqual(g.standings().map((x) => x.score), [3, 15]);
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
      if (m.action === 'play') g.play(id, m.tileIds, m.row, m.count);
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
  g.play(id, m.tileIds, m.row, m.count);
  const restored = SixteenGame.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.deepEqual(restored.publicView(), g.publicView());
  assert.equal(restored.rng, Math.random);
  const next = restored.players[restored.current];
  const m2 = botMove(restored, next.id);
  if (m2.action === 'play') restored.play(next.id, m2.tileIds, m2.row, m2.count);
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

test('모든 타일에 이미지 파일이 있다 (public/tiles)', async () => {
  const { existsSync } = await import('node:fs');
  const name = (t) => (t.k === 'scissors' || t.k === 'trash' ? t.k : t.k === 'num' ? `${t.c}-${t.n}` : `${t.c}-${t.k}`);
  const files = new Set(createDeck().map((t) => `${name(t)}.svg`));
  files.add('back.svg');
  assert.equal(files.size, 88, '숫자 75 + RESTART 5 + END 5 + 가위 + 쓰레기통 + 뒷면');
  for (const f of files) assert.ok(existsSync(new URL(`../public/tiles/${f}`, import.meta.url)), `public/tiles/${f} 없음 (npm run tiles)`);
});
