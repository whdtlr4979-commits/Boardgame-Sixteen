/**
 * 식스틴(Sixteen) 게임 엔진 — 네트워크와 무관한 순수 로직.
 * 브라우저(public/game.js)와 Supabase Edge Function이 같은 코드를 사용한다.
 * public/game.js는 `npm run sync` 로 이 파일을 복사한 것이다.
 *
 * 구성물 (88개)
 *   색마다 숫자 1~15 + 16 RESTART + 16 END = 17개 × 5색 = 85개
 *   가위 2개, 쓰레기통 1개
 *
 * 규칙
 *   - 타일을 인원수에 따라 나눠 준다 (2인 30개, 3인 29개, 4인 22개, 나머지는 사용하지 않음).
 *   - 1 타일 5개를 모두 꺼내 색깔별 줄 5개를 시작한다.
 *   - 자기 차례에 같은 색 타일 1개 또는 연속된 숫자 여러 개를 그 색 줄 끝에 놓는다.
 *     줄 끝보다 큰 숫자만 놓을 수 있고, 숫자를 건너뛸 수 있다.
 *   - RESTART: 16으로 놓이고 이후 0으로 취급 → 그 줄을 처음부터 다시 이어갈 수 있다.
 *   - END: 16으로 놓이고 그 줄을 닫는다.
 *   - 가위: 원하는 줄의 마지막 타일 1개를 제거한다. 쓰레기통: 원하는 줄을 1만 남기고 비운다.
 *   - 놓을 수 있는 타일이 없을 때만 패스한다.
 *   - 손패를 모두 내려놓은 사람이 승리. 모두 연속으로 패스하면(아무도 놓을 수 없으면)
 *     남은 타일 숫자 합이 가장 적은 사람이 승리.
 */

/** 규칙 위반 — 메시지를 그대로 사용자에게 보여줘도 되는 오류. */
export class RuleError extends Error {}

export const COLORS = ['red', 'yellow', 'green', 'blue', 'purple'];
export const COLOR_NAMES = { red: '빨강', yellow: '노랑', green: '초록', blue: '파랑', purple: '보라' };
export const MAX_NUMBER = 15;
export const SPECIAL_VALUE = 16;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const HAND_SIZE = { 2: 30, 3: 29, 4: 22 };
export const SCISSORS_COUNT = 2;
export const TRASH_COUNT = 1;

/** 타일 종류: num(숫자), restart, end, scissors(가위), trash(쓰레기통) */
export const isColorless = (t) => t.k === 'scissors' || t.k === 'trash';

export function createDeck() {
  const deck = [];
  let id = 0;
  for (const c of COLORS) {
    for (let n = 1; n <= MAX_NUMBER; n++) deck.push({ id: id++, c, n, k: 'num' });
    deck.push({ id: id++, c, n: SPECIAL_VALUE, k: 'restart' });
    deck.push({ id: id++, c, n: SPECIAL_VALUE, k: 'end' });
  }
  for (let i = 0; i < SCISSORS_COUNT; i++) deck.push({ id: id++, c: null, n: 0, k: 'scissors' });
  for (let i = 0; i < TRASH_COUNT; i++) deck.push({ id: id++, c: null, n: 0, k: 'trash' });
  return deck;
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const KIND_ORDER = { num: 0, restart: 1, end: 2, scissors: 3, trash: 4 };

/** 손패 정렬: 색깔별로 모아 숫자 오름차순, RESTART·END는 색 끝, 가위·쓰레기통은 맨 뒤. */
export function sortHand(hand) {
  const key = (t) => (isColorless(t)
    ? 1000 + KIND_ORDER[t.k]
    : COLORS.indexOf(t.c) * 100 + t.n * 3 + KIND_ORDER[t.k]);
  return hand.slice().sort((a, b) => key(a) - key(b) || a.id - b.id);
}

/** 남은 타일 벌점: 숫자는 그 값, RESTART·END는 16, 가위·쓰레기통은 0. */
export function tilePenalty(t) {
  return isColorless(t) ? 0 : t.n;
}

export function describeTile(t) {
  if (t.k === 'scissors') return '가위';
  if (t.k === 'trash') return '쓰레기통';
  const color = COLOR_NAMES[t.c];
  if (t.k === 'restart') return `${color} RESTART`;
  if (t.k === 'end') return `${color} END`;
  return `${color} ${t.n}`;
}

/** 줄 끝의 현재 값 (RESTART 뒤에는 0). */
export function rowTop(row) {
  let top = 0;
  for (const t of row.tiles) top = t.k === 'restart' ? 0 : t.n;
  return top;
}

function rowClosed(row) {
  const last = row.tiles[row.tiles.length - 1];
  return !!last && last.k === 'end';
}

/**
 * 선택한 타일을 놓을 수 있는지 검사한다.
 * @returns {{ok:true, row:string, kind:string, label:string} | {ok:false, error:string}}
 */
export function validatePlay(rows, tiles, rowColor) {
  if (!tiles.length) return { ok: false, error: '타일을 선택하세요.' };

  const special = tiles.find(isColorless);
  if (special) {
    if (tiles.length > 1) return { ok: false, error: '가위·쓰레기통은 한 개씩만 사용할 수 있습니다.' };
    if (!rowColor) return { ok: false, error: `${describeTile(special)}을(를) 사용할 줄을 고르세요.` };
    const row = rows.find((r) => r.color === rowColor);
    if (!row) return { ok: false, error: '없는 줄입니다.' };
    if (row.tiles.length <= 1) return { ok: false, error: '1만 있는 줄에는 사용할 수 없습니다.' };
    const label = special.k === 'scissors'
      ? `✂ ${COLOR_NAMES[rowColor]} 줄의 ${describeTile(row.tiles[row.tiles.length - 1])} 제거`
      : `🗑 ${COLOR_NAMES[rowColor]} 줄 비우기`;
    return { ok: true, row: rowColor, kind: special.k, label };
  }

  const color = tiles[0].c;
  if (tiles.some((t) => t.c !== color)) return { ok: false, error: '같은 색 타일만 함께 놓을 수 있습니다.' };
  if (rowColor && rowColor !== color) return { ok: false, error: '타일과 같은 색 줄에만 놓을 수 있습니다.' };
  const row = rows.find((r) => r.color === color);
  if (rowClosed(row)) return { ok: false, error: `${COLOR_NAMES[color]} 줄은 END로 닫혔습니다.` };

  const seq = tiles.slice().sort((a, b) => a.n - b.n || KIND_ORDER[a.k] - KIND_ORDER[b.k]);
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].n !== seq[i - 1].n + 1) return { ok: false, error: '여러 개를 놓을 때는 연속된 숫자여야 합니다.' };
  }
  const top = rowTop(row);
  if (seq[0].n <= top) return { ok: false, error: `${COLOR_NAMES[color]} 줄 끝(${top})보다 큰 숫자만 놓을 수 있습니다.` };

  const last = seq[seq.length - 1];
  const nums = seq.map((t) => (t.k === 'num' ? t.n : t.k === 'restart' ? 'RESTART' : 'END'));
  const label = `${COLOR_NAMES[color]} ${nums.length > 2 ? `${nums[0]}…${nums[nums.length - 1]}` : nums.join(', ')}`
    + (last.k === 'restart' ? ' ↻' : last.k === 'end' ? ' ■' : '');
  return { ok: true, row: color, kind: 'run', label, seq };
}

/** 가능한 모든 수 목록: [{ tileIds, row }] */
export function legalMoves(rows, hand) {
  const moves = [];
  for (const row of rows) {
    if (rowClosed(row)) continue;
    const top = rowTop(row);
    const mine = hand.filter((t) => t.c === row.color && t.n > top);
    const byN = new Map();
    for (const t of mine) (byN.get(t.n) || byN.set(t.n, []).get(t.n)).push(t);
    // 각 시작 타일에서 연속된 숫자로 늘려가며 모든 런을 만든다 (16은 RESTART/END 분기).
    const extend = (run) => {
      moves.push({ tileIds: run.map((t) => t.id), row: row.color });
      const last = run[run.length - 1];
      if (last.n >= SPECIAL_VALUE) return;
      for (const next of byN.get(last.n + 1) || []) extend([...run, next]);
    };
    for (const t of mine) extend([t]);
  }
  const seen = new Set();
  for (const t of hand.filter(isColorless)) {
    if (seen.has(t.k)) continue;
    seen.add(t.k);
    for (const row of rows) if (row.tiles.length > 1) moves.push({ tileIds: [t.id], row: row.color });
  }
  return moves;
}

export function hasLegalMove(rows, hand) {
  for (const row of rows) {
    if (!rowClosed(row) && hand.some((t) => t.c === row.color && t.n > rowTop(row))) return true;
  }
  return hand.some(isColorless) && rows.some((r) => r.tiles.length > 1);
}

export class SixteenGame {
  /**
   * @param {{id:string,name:string,isBot?:boolean}[]} players 좌석 순서
   * @param {{rng?:()=>number}} opts
   */
  constructor(players, opts = {}) {
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
      throw new RuleError(`플레이어 수는 ${MIN_PLAYERS}~${MAX_PLAYERS}명이어야 합니다.`);
    }
    this.rng = opts.rng || Math.random;
    this.log = [];
    this.turnId = 0;
    this.passes = 0;
    this.discard = [];
    this.lastPlay = null;
    this.lastRound = null;

    const deck = shuffle(createDeck(), this.rng);
    const size = HAND_SIZE[players.length];
    const hands = players.map(() => deck.splice(0, size));
    const unused = deck;

    // 1 타일은 누가 받았든 모두 꺼내 줄을 시작한다.
    const isOne = (t) => t.k === 'num' && t.n === 1;
    const ones = [...hands.flat(), ...unused].filter(isOne);
    this.rows = COLORS.map((c) => ({ color: c, tiles: [ones.find((t) => t.c === c)] }));
    this.unused = unused.filter((t) => !isOne(t));

    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      hand: sortHand(hands[i].filter((t) => !isOne(t))),
      score: 0,
    }));
    this.current = Math.floor(this.rng() * players.length);
    this.phase = 'playing';
    this.addLog(`게임 시작! 1 타일 5개로 줄을 만들었습니다. ${this.players[this.current].name}님부터 시작합니다.`);
  }

  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 60) this.log.shift();
  }

  seatOf(id) {
    return this.players.findIndex((p) => p.id === id);
  }

  assertTurn(id) {
    if (this.phase !== 'playing') throw new RuleError('게임이 진행 중이 아닙니다.');
    const seat = this.seatOf(id);
    if (seat < 0) throw new RuleError('이 게임의 플레이어가 아닙니다.');
    if (seat !== this.current) throw new RuleError('당신의 차례가 아닙니다.');
    return this.players[seat];
  }

  /**
   * 타일을 놓는다.
   * @param {number[]} tileIds 놓을 타일 (숫자 런 또는 가위/쓰레기통 1개)
   * @param {string} [rowColor] 대상 줄 (가위/쓰레기통일 때 필수)
   */
  play(id, tileIds, rowColor) {
    const p = this.assertTurn(id);
    if (!Array.isArray(tileIds) || tileIds.length === 0) throw new RuleError('타일을 선택하세요.');
    if (new Set(tileIds).size !== tileIds.length) throw new RuleError('같은 타일을 중복 선택했습니다.');
    const tiles = tileIds.map((tid) => p.hand.find((t) => t.id === tid));
    if (tiles.some((t) => !t)) throw new RuleError('손에 없는 타일입니다.');

    const v = validatePlay(this.rows, tiles, rowColor);
    if (!v.ok) throw new RuleError(v.error);
    const row = this.rows.find((r) => r.color === v.row);

    if (v.kind === 'scissors') {
      this.discard.push(row.tiles.pop(), tiles[0]);
    } else if (v.kind === 'trash') {
      this.discard.push(...row.tiles.splice(1), tiles[0]);
    } else {
      row.tiles.push(...v.seq);
    }
    p.hand = p.hand.filter((t) => !tileIds.includes(t.id));
    this.passes = 0;
    this.lastPlay = { by: this.current, row: v.row, kind: v.kind, tiles: v.kind === 'run' ? v.seq : tiles };
    this.addLog(`${p.name}: ${v.label}`);

    if (p.hand.length === 0) {
      this.finish(this.current);
      return { kind: v.kind, finished: true };
    }
    this.advance();
    return { kind: v.kind, finished: false };
  }

  pass(id) {
    const p = this.assertTurn(id);
    if (hasLegalMove(this.rows, p.hand)) throw new RuleError('놓을 수 있는 타일이 있으면 패스할 수 없습니다.');
    this.passes += 1;
    this.addLog(`${p.name}: 패스 (놓을 수 있는 타일 없음)`);
    if (this.passes >= this.players.length) {
      this.finish(null);
    } else {
      this.advance();
    }
    return {};
  }

  advance() {
    this.current = (this.current + 1) % this.players.length;
    this.turnId += 1;
  }

  /** @param {number|null} emptiedSeat 손패를 모두 턴 플레이어 (없으면 null = 아무도 놓을 수 없음) */
  finish(emptiedSeat) {
    const results = this.players.map((p) => {
      p.score = p.hand.reduce((s, t) => s + tilePenalty(t), 0);
      return { id: p.id, name: p.name, penalty: p.score, remaining: sortHand(p.hand) };
    });
    const winner = emptiedSeat ?? results.reduce((best, r, i) => (r.penalty < results[best].penalty ? i : best), 0);
    this.lastRound = { winner, emptied: emptiedSeat !== null, results };
    this.phase = 'finished';
    this.addLog(emptiedSeat !== null
      ? `🏆 ${this.players[winner].name}님이 타일을 모두 내려놓고 승리했습니다!`
      : `아무도 더 놓을 수 없습니다. 🏆 남은 숫자 합이 가장 적은 ${this.players[winner].name}님(${results[winner].penalty}점) 승리!`);
    this.turnId += 1;
  }

  standings() {
    const winnerId = this.lastRound ? this.players[this.lastRound.winner].id : null;
    return this.players
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => (a.id === winnerId ? -1 : b.id === winnerId ? 1 : a.score - b.score));
  }

  /** 모든 사람에게 공개되는 상태 (손패는 개수만 — 가림막). */
  publicView() {
    return {
      phase: this.phase,
      current: this.current,
      turnId: this.turnId,
      lastMoveAt: this.lastMoveAt || null,
      rows: this.rows.map((r) => ({ color: r.color, tiles: r.tiles, top: rowTop(r), closed: rowClosed(r) })),
      discard: this.discard.length,
      unused: this.unused.length,
      passes: this.passes,
      lastPlay: this.lastPlay,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        count: p.hand.length,
        score: p.score,
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
/* 봇: 가능한 수를 점수로 평가해 가장 좋은 수를 둔다.                    */
/*  - 많이, 높은 숫자를 털어낼수록 좋다.                                  */
/*  - 숫자를 건너뛰어 내 타일이 못 쓰게 되면 감점, 다시 살아나면 가점.     */
/* ------------------------------------------------------------------ */

function evaluate(game, hand, move) {
  const row = game.rows.find((r) => r.color === move.row);
  const top = rowTop(row);
  const tiles = move.tileIds.map((id) => hand.find((t) => t.id === id));
  const rest = hand.filter((t) => !move.tileIds.includes(t.id));
  const sameColor = rest.filter((t) => t.c === row.color);
  const sum = (ts) => ts.reduce((s, t) => s + tilePenalty(t), 0);

  if (isColorless(tiles[0])) {
    const newTop = tiles[0].k === 'trash' ? 1 : rowTop({ tiles: row.tiles.slice(0, -1) });
    const revived = sameColor.filter((t) => t.n > newTop && t.n <= top);
    return 1 + sum(revived) * 0.8;
  }
  const seq = tiles.slice().sort((a, b) => a.n - b.n);
  const first = seq[0].n;
  const last = seq[seq.length - 1];
  let score = sum(tiles) + tiles.length * 3;
  const skipped = sameColor.filter((t) => t.n > top && t.n < first);
  score -= sum(skipped) * 1.2;
  if (last.k === 'end') score -= sum(sameColor.filter((t) => t.n > top)) * 1.2;
  if (last.k === 'restart') score += sum(sameColor.filter((t) => t.n <= top)) * 0.5;
  return score;
}

export function botMove(game, id) {
  const p = game.players[game.seatOf(id)];
  const moves = legalMoves(game.rows, p.hand);
  if (!moves.length) return { action: 'pass' };
  let best = null;
  for (const m of moves) {
    const s = evaluate(game, p.hand, m) + game.rng() * 0.01;
    if (!best || s > best.s) best = { m, s };
  }
  return { action: 'play', tileIds: best.m.tileIds, row: best.m.row };
}
