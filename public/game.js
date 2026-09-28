/**
 * 식스틴(Sixteen) 게임 엔진 — 네트워크와 무관한 순수 로직.
 * 브라우저(public/game.js)와 Supabase Edge Function이 같은 코드를 사용한다.
 * public/game.js는 `npm run sync` 로 이 파일을 복사한 것이다.
 *
 * 구성물: 5가지 색 × 숫자 1~16 타일 80개 + 조커 8개 = 총 88개
 * 목표: 손패를 먼저 모두 내려놓고, 라운드가 끝났을 때 남은 숫자의 합을 최소화한다.
 */

/** 규칙 위반 — 메시지를 그대로 사용자에게 보여줘도 되는 오류. */
export class RuleError extends Error {}

export const COLORS = ['red', 'yellow', 'green', 'blue', 'purple'];
export const MAX_NUMBER = 16;
const JOKER_COUNT = 8;
export const JOKER_PENALTY = 20;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
const MIN_RUN = 3;

export function createDeck() {
  const deck = [];
  let id = 0;
  for (const c of COLORS) {
    for (let n = 1; n <= MAX_NUMBER; n++) deck.push({ id: id++, n, c });
  }
  for (let i = 0; i < JOKER_COUNT; i++) deck.push({ id: id++, n: 0, c: 'joker' });
  return deck;
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 손패 정렬: 숫자 오름차순, 같은 숫자는 색 순서, 조커는 맨 뒤. */
export function sortHand(hand) {
  const key = (t) => (t.n === 0 ? 1000 : t.n * 10 + COLORS.indexOf(t.c));
  return hand.slice().sort((a, b) => key(a) - key(b));
}

function handSize(playerCount) {
  return playerCount <= 3 ? 16 : 14;
}

function tilePenalty(t) {
  return t.n === 0 ? JOKER_PENALTY : t.n;
}

/**
 * 선택한 타일로 만들 수 있는 조합 해석 목록을 반환한다.
 *  - single: 타일 1개
 *  - set:    같은 숫자 2개 이상 (색 무관)
 *  - run:    연속된 숫자 3개 이상 (색 무관, 숫자 중복 불가)
 * 조커는 어떤 숫자로도 쓸 수 있다. value는 비교 기준(세트=숫자, 런=가장 높은 숫자).
 */
export function interpret(tiles) {
  const k = tiles.length;
  if (k === 0) return [];
  const nums = tiles.filter((t) => t.n > 0).map((t) => t.n);
  const out = [];

  if (k === 1) {
    return [{ type: 'single', size: 1, value: nums.length ? nums[0] : MAX_NUMBER }];
  }

  // 세트
  if (nums.every((n) => n === nums[0] || nums.length === 0)) {
    out.push({ type: 'set', size: k, value: nums.length ? nums[0] : MAX_NUMBER });
  }

  // 런
  if (k >= MIN_RUN && k <= MAX_NUMBER && new Set(nums).size === nums.length) {
    if (nums.length === 0) {
      out.push({ type: 'run', size: k, value: MAX_NUMBER });
    } else {
      const lo = Math.min(...nums);
      const hi = Math.max(...nums);
      if (hi - lo + 1 <= k) {
        // 조커로 위쪽을 최대한 채워 가장 높은 값을 만든다.
        const top = Math.min(MAX_NUMBER, lo + k - 1);
        out.push({ type: 'run', size: k, value: top });
      }
    }
  }
  return out;
}

export function beats(combo, table) {
  if (!table) return true;
  return combo.type === table.type && combo.size === table.size && combo.value > table.value;
}

/** 테이블을 이길 수 있는 가장 좋은 해석을 고른다. (선이면 가장 강한 해석) */
export function chooseInterpretation(tiles, table) {
  const options = interpret(tiles).filter((c) => beats(c, table));
  if (!options.length) return null;
  options.sort((a, b) => b.value - a.value || (a.type === 'run' ? -1 : 1));
  return options[0];
}

export function describeCombo(combo) {
  if (!combo) return '';
  if (combo.type === 'single') return `싱글 ${combo.value}`;
  if (combo.type === 'set') return `${combo.value} × ${combo.size} 세트`;
  return `${combo.value - combo.size + 1}–${combo.value} 런`;
}

export class SixteenGame {
  /**
   * @param {{id:string,name:string,isBot?:boolean}[]} players 좌석 순서
   * @param {{rounds?:number, rng?:()=>number}} opts
   */
  constructor(players, opts = {}) {
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
      throw new RuleError(`플레이어 수는 ${MIN_PLAYERS}~${MAX_PLAYERS}명이어야 합니다.`);
    }
    this.rng = opts.rng || Math.random;
    this.maxRounds = opts.rounds || 3;
    this.round = 0;
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      hand: [],
      score: 0,
      roundScores: [],
    }));
    this.phase = 'idle';
    this.log = [];
    this.startingSeat = Math.floor(this.rng() * players.length);
    this.startRound();
  }

  startRound() {
    this.round += 1;
    const deck = shuffle(createDeck(), this.rng);
    const size = handSize(this.players.length);
    for (const p of this.players) {
      p.hand = sortHand(deck.splice(0, size));
    }
    this.drawPile = deck;
    this.table = null; // { combo, tiles, by }
    this.passes = 0;
    this.current = (this.startingSeat + this.round - 1) % this.players.length;
    this.leader = this.current;
    this.phase = 'playing';
    this.lastRound = null;
    this.turnId = (this.turnId || 0) + 1;
    this.addLog(`라운드 ${this.round} 시작! ${this.players[this.current].name}님이 선입니다.`);
  }

  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 60) this.log.shift();
  }

  seatOf(id) {
    return this.players.findIndex((p) => p.id === id);
  }

  assertTurn(id) {
    if (this.phase !== 'playing') throw new RuleError('지금은 진행 중인 라운드가 없습니다.');
    const seat = this.seatOf(id);
    if (seat < 0) throw new RuleError('이 게임의 플레이어가 아닙니다.');
    if (seat !== this.current) throw new RuleError('당신의 차례가 아닙니다.');
    return this.players[seat];
  }

  play(id, tileIds) {
    const p = this.assertTurn(id);
    if (!Array.isArray(tileIds) || tileIds.length === 0) throw new RuleError('타일을 선택하세요.');
    if (new Set(tileIds).size !== tileIds.length) throw new RuleError('같은 타일을 중복 선택했습니다.');
    const tiles = tileIds.map((tid) => p.hand.find((t) => t.id === tid));
    if (tiles.some((t) => !t)) throw new RuleError('손에 없는 타일입니다.');

    const tableCombo = this.table ? this.table.combo : null;
    const combo = chooseInterpretation(tiles, tableCombo);
    if (!combo) {
      if (!interpret(tiles).length) throw new RuleError('올바른 조합이 아닙니다. (싱글 / 같은 숫자 세트 / 3개 이상 연속 런)');
      throw new RuleError(`${describeCombo(tableCombo)}보다 높은 같은 형태의 조합을 내야 합니다.`);
    }

    p.hand = p.hand.filter((t) => !tileIds.includes(t.id));
    this.table = { combo, tiles: sortHand(tiles), by: this.current };
    this.passes = 0;
    this.addLog(`${p.name}: ${describeCombo(combo)}`);

    if (p.hand.length === 0) {
      this.endRound(this.current);
      return { combo, roundOver: true };
    }
    this.advance();
    return { combo, roundOver: false };
  }

  pass(id) {
    const p = this.assertTurn(id);
    if (!this.table) throw new RuleError('선 플레이어는 패스할 수 없습니다. 타일을 내려놓으세요.');
    let drew = null;
    if (this.drawPile.length) {
      drew = this.drawPile.pop();
      p.hand = sortHand([...p.hand, drew]);
    }
    this.passes += 1;
    this.addLog(`${p.name}: 패스${drew ? ' (타일 1개 획득)' : ''}`);

    if (this.passes >= this.players.length - 1) {
      // 모두 패스 → 마지막으로 낸 사람이 새로 선을 잡는다.
      const leader = this.table.by;
      this.table = null;
      this.passes = 0;
      this.current = leader;
      this.leader = leader;
      this.turnId += 1;
      this.addLog(`모두 패스! ${this.players[leader].name}님이 새로 선을 잡습니다.`);
    } else {
      this.advance();
    }
    return { drew };
  }

  advance() {
    this.current = (this.current + 1) % this.players.length;
    this.turnId += 1;
  }

  endRound(winnerSeat) {
    const results = this.players.map((p, i) => {
      const penalty = i === winnerSeat ? 0 : p.hand.reduce((s, t) => s + tilePenalty(t), 0);
      p.score += penalty;
      p.roundScores.push(penalty);
      return { id: p.id, name: p.name, penalty, remaining: sortHand(p.hand) };
    });
    this.lastRound = { winner: winnerSeat, results };
    this.addLog(`🎉 ${this.players[winnerSeat].name}님이 라운드 ${this.round}에서 승리했습니다!`);
    this.phase = this.round >= this.maxRounds ? 'finished' : 'roundEnd';
    if (this.phase === 'finished') {
      const w = this.standings()[0];
      this.addLog(`🏆 최종 우승: ${w.name} (${w.score}점)`);
    }
    this.turnId += 1;
  }

  nextRound() {
    if (this.phase !== 'roundEnd') throw new RuleError('다음 라운드를 시작할 수 없습니다.');
    this.startRound();
  }

  standings() {
    return this.players
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => a.score - b.score);
  }

  /** 모든 사람에게 공개되는 상태 (손패는 개수만 — 가림막). */
  publicView() {
    return {
      phase: this.phase,
      round: this.round,
      maxRounds: this.maxRounds,
      current: this.current,
      turnId: this.turnId,
      lastMoveAt: this.lastMoveAt || null,
      drawPile: this.drawPile.length,
      table: this.table && {
        combo: this.table.combo,
        label: describeCombo(this.table.combo),
        tiles: this.table.tiles,
        by: this.table.by,
      },
      passes: this.passes,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        count: p.hand.length,
        score: p.score,
        roundScores: p.roundScores,
      })),
      lastRound: this.lastRound,
      standings: this.phase === 'finished' ? this.standings() : null,
      log: this.log.slice(-30),
    };
  }

  /** 특정 플레이어에게 보여줄 상태: 공개 상태 + 자기 손패. */
  viewFor(id) {
    const me = this.players.find((p) => p.id === id);
    return { ...this.publicView(), hand: me ? me.hand : null };
  }

  /** 자리 주인을 봇 ↔ 사람으로 바꾼다 (나간 플레이어 대체, 재접속 시 복귀). */
  setBot(id, isBot, name) {
    const p = this.players.find((x) => x.id === id);
    if (!p) return;
    p.isBot = isBot;
    if (name) p.name = name;
  }

  /** DB에 저장할 수 있는 순수 JSON (rng 함수 제외). */
  toJSON() {
    const { rng, ...rest } = this;
    return JSON.parse(JSON.stringify(rest));
  }

  static fromJSON(data, rng = Math.random) {
    const g = Object.create(SixteenGame.prototype);
    Object.assign(g, JSON.parse(JSON.stringify(data)));
    g.rng = rng;
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* 봇: 낼 수 있는 가장 약한 조합을 내고, 없으면 패스한다.                  */
/* ------------------------------------------------------------------ */

function* combinations(hand, table) {
  const byNum = new Map();
  const jokers = hand.filter((t) => t.n === 0);
  for (const t of hand) if (t.n > 0) (byNum.get(t.n) || byNum.set(t.n, []).get(t.n)).push(t);

  const wantType = table && table.type;
  const wantSize = table && table.size;

  if (!table || wantType === 'single') {
    for (const t of hand) yield [t];
  }
  if (!table || wantType === 'set') {
    for (const [, ts] of byNum) {
      const sizes = table ? [wantSize] : [ts.length];
      for (const size of sizes) {
        if (size < 2) continue;
        const need = Math.max(0, size - ts.length);
        if (need <= jokers.length) yield [...ts.slice(0, size), ...jokers.slice(0, need)];
      }
    }
  }
  if (!table || wantType === 'run') {
    const sizes = table ? [wantSize] : [5, 4, 3];
    for (const size of sizes) {
      for (let lo = 1; lo + size - 1 <= MAX_NUMBER; lo++) {
        const picked = [];
        let jUsed = 0;
        for (let n = lo; n < lo + size; n++) {
          const ts = byNum.get(n);
          if (ts) picked.push(ts[0]);
          else jUsed++;
        }
        if (jUsed <= jokers.length && jUsed < size) yield [...picked, ...jokers.slice(0, jUsed)];
      }
    }
  }
}

export function botMove(game, id) {
  const p = game.players[game.seatOf(id)];
  const tableCombo = game.table ? game.table.combo : null;
  let best = null;
  for (const tiles of combinations(p.hand, tableCombo)) {
    const combo = chooseInterpretation(tiles, tableCombo);
    if (!combo) continue;
    const jokers = tiles.filter((t) => t.n === 0).length;
    // 선일 때는 많이 털어내는 수를, 따라갈 때는 낮은 값을 선호. 조커는 아낀다.
    const score = tableCombo
      ? combo.value + jokers * 8
      : -tiles.length * 10 + combo.value / 4 + jokers * 12;
    if (!best || score < best.score) best = { tiles, score };
  }
  if (best) return { action: 'play', tileIds: best.tiles.map((t) => t.id) };
  return { action: 'pass' };
}

