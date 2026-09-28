import test from 'node:test';
import assert from 'node:assert';
import { createDeck, interpret, beats, chooseInterpretation, SixteenGame, botMove } from '../supabase/functions/_shared/game.js';

const t = (n, c = 'red', id = Math.random()) => ({ id, n, c });
const J = () => t(0, 'joker');

test('덱은 5색 × 16 + 조커 8 = 88장', () => {
  const d = createDeck();
  assert.strictEqual(d.length, 88);
  assert.strictEqual(d.filter((x) => x.n === 0).length, 8);
  assert.strictEqual(new Set(d.map((x) => x.id)).size, 88);
});

test('조합 해석: 싱글 / 세트 / 런', () => {
  assert.deepStrictEqual(interpret([t(7)]), [{ type: 'single', size: 1, value: 7 }]);
  assert.deepStrictEqual(interpret([t(7), t(7, 'blue')]), [{ type: 'set', size: 2, value: 7 }]);
  assert.deepStrictEqual(interpret([t(3), t(4, 'blue'), t(5, 'green')]), [{ type: 'run', size: 3, value: 5 }]);
  assert.deepStrictEqual(interpret([t(3), t(5)]), []);
  assert.deepStrictEqual(interpret([t(3), t(4)]), [], '2장짜리 런은 불가');
  assert.deepStrictEqual(interpret([t(3), t(3), t(4)]), []);
});

test('조커는 빈 자리를 채우고 가능한 높은 값을 만든다', () => {
  const runs = interpret([t(3), J(), t(5)]).filter((c) => c.type === 'run');
  assert.deepStrictEqual(runs, [{ type: 'run', size: 3, value: 5 }]);
  const up = interpret([t(14), J(), J()]).find((c) => c.type === 'run');
  assert.strictEqual(up.value, 16);
  const set = interpret([t(9), J()]);
  assert.deepStrictEqual(set, [{ type: 'set', size: 2, value: 9 }]);
});

test('같은 형태·같은 개수·더 높은 값만 이긴다', () => {
  const table = { type: 'run', size: 3, value: 7 };
  assert.ok(beats({ type: 'run', size: 3, value: 8 }, table));
  assert.ok(!beats({ type: 'run', size: 3, value: 7 }, table));
  assert.ok(!beats({ type: 'run', size: 4, value: 12 }, table));
  assert.ok(!beats({ type: 'set', size: 3, value: 12 }, table));
  // 모호한 조합은 테이블을 이기는 해석을 선택
  const c = chooseInterpretation([t(8), J(), J()], { type: 'set', size: 3, value: 5 });
  assert.deepStrictEqual(c, { type: 'set', size: 3, value: 8 });
});

function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

test('게임 흐름: 차례, 패스, 선 넘기기, 규칙 위반 거부', () => {
  const g = new SixteenGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], { rounds: 1, rng: seeded(7) });
  assert.strictEqual(g.players[0].hand.length, 16);
  const p = g.players[g.current];
  const other = g.players[(g.current + 1) % 3];
  assert.throws(() => g.play(other.id, [other.hand[0].id]), /차례/);
  assert.throws(() => g.pass(p.id), /패스할 수 없습니다/);
  assert.throws(() => g.play(p.id, [other.hand[0].id]), /손에 없는/);

  const lowest = p.hand[0];
  g.play(p.id, [lowest.id]);
  assert.strictEqual(g.table.by, g.players.indexOf(p));
  const pile = g.drawPile.length;
  const n1 = g.players[g.current];
  const before = n1.hand.length;
  g.pass(n1.id);
  assert.strictEqual(n1.hand.length, before + 1);
  assert.strictEqual(g.drawPile.length, pile - 1);
  g.pass(g.players[g.current].id);
  assert.strictEqual(g.table, null, '모두 패스하면 테이블 정리');
  assert.strictEqual(g.players[g.current].id, p.id, '마지막으로 낸 사람이 선');
});

test('봇끼리 전체 게임을 끝까지 진행할 수 있다', () => {
  for (let s = 1; s <= 30; s++) {
    const n = 2 + (s % 4);
    const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: true }));
    const g = new SixteenGame(players, { rounds: 2, rng: seeded(s) });
    let steps = 0;
    while (g.phase !== 'finished') {
      if (g.phase === 'roundEnd') { g.nextRound(); continue; }
      const id = g.players[g.current].id;
      const m = botMove(g, id);
      if (m.action === 'play') g.play(id, m.tileIds); else g.pass(id);
      assert.ok(++steps < 5000, 'game should terminate');
    }
    const total = g.players.reduce((a, p) => a + p.roundScores.length, 0);
    assert.strictEqual(total, n * 2);
    assert.ok(g.standings()[0].score <= g.standings()[n - 1].score);
  }
});

test('viewFor는 다른 사람의 손패를 숨긴다', () => {
  const g = new SixteenGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rng: seeded(3) });
  const v = g.viewFor('a');
  assert.strictEqual(v.hand.length, 16);
  assert.ok(v.players.every((p) => p.hand === undefined && typeof p.count === 'number'));
});

test('toJSON/fromJSON 으로 저장했다 불러와도 게임이 이어진다', () => {
  const g = new SixteenGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rng: seeded(11) });
  const id = g.players[g.current].id;
  g.play(id, [g.players[g.current].hand[0].id]);
  const restored = SixteenGame.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.deepStrictEqual(restored.publicView(), g.publicView());
  assert.strictEqual(restored.rng, Math.random);
  const next = restored.players[restored.current];
  restored.pass(next.id);
  assert.strictEqual(restored.table, null);
});

test('public/game.js 는 엔진 원본과 동일하다 (npm run sync)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../supabase/functions/_shared/game.js', import.meta.url), 'utf8');
  const pub = await readFile(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.strictEqual(pub, src, 'npm run sync 를 실행하세요');
});
