/**
 * 식스틴 온라인 — 방/게임 액션 처리.
 *
 * DB 접근은 `db` 어댑터로 분리되어 있어 Edge Function(Supabase)과
 * 테스트(메모리 DB)에서 같은 코드를 쓴다. 어댑터 인터페이스:
 *
 *   getRoom(code)                         → room | null
 *   findRoomByMember(field, userId)       → room | null   (field: 'userId' | 'formerUserId')
 *   insertRoom(room)                      → boolean (코드 중복이면 false)
 *   updateRoom(code, version, patch)      → boolean (버전이 다르면 false)
 *   deleteRoom(code)
 *   loadGame(code)                        → { state, version } | null
 *   commitGame(code, expectedVersion|null, state, view, hands, status) → newVersion (충돌 시 ConflictError)
 *   clearGame(code)
 *   addMessage({ room_code, member_id, name, avatar, text, system })
 *   cleanup()                             → 오래된 방 정리
 */
import { SixteenGame, RuleError, botMove, MIN_PLAYERS, MAX_PLAYERS } from './game.js';

export const AVATARS = ['🦊', '🐼', '🐯', '🐨', '🐸', '🐙', '🦄', '🐧', '🦁', '🐰', '🐻', '🐳'];
const BOT_NAMES = ['알파봇', '베타봇', '감마봇', '델타봇', '엡실론봇'];
/** 현재 차례인 플레이어가 이 시간 동안 응답이 없으면 다른 사람이 봇으로 대체할 수 있다. */
export const STALL_MS = 60_000;

export class UserError extends Error {}
export class ConflictError extends Error {}

const clean = (s, max = 20) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const clamp = (n, lo, hi, dflt) => Math.min(hi, Math.max(lo, Number(n) || dflt));

function randomId() {
  return crypto.randomUUID();
}

function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function profileOf(p) {
  const name = clean(p?.name, 12);
  if (!name) throw new UserError('닉네임을 입력하세요.');
  const avatar = AVATARS.includes(p?.avatar) ? p.avatar : AVATARS[0];
  return { name, avatar };
}

export function createCore(db, opts = {}) {
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const botDelay = opts.botDelay ?? 900;

  /* ---------------- 공통 헬퍼 ---------------- */

  async function requireRoomOf(userId) {
    const room = await db.findRoomByMember('userId', userId);
    if (!room) throw new UserError('참여 중인 방이 없습니다.');
    return room;
  }

  function memberOf(room, userId) {
    return room.members.find((m) => m.userId === userId);
  }

  function requireHost(room, userId) {
    if (room.host_id !== userId) throw new UserError('방장만 할 수 있습니다.');
  }

  /**
   * 방을 낙관적 동시성 제어로 수정한다. fn(room)이 patch를 반환하면 저장,
   * null을 반환하면 방을 삭제한다. 버전 충돌 시 다시 읽어서 재시도.
   */
  async function mutateRoom(code, fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const room = await db.getRoom(code);
      if (!room) throw new UserError('방을 찾을 수 없습니다.');
      const draft = structuredClone(room);
      const result = await fn(draft);
      if (result === null) {
        await db.deleteRoom(code);
        return null;
      }
      const patch = result || {
        name: draft.name,
        host_id: draft.host_id,
        max_players: draft.max_players,
        rounds: draft.rounds,
        status: draft.status,
        members: draft.members,
      };
      if (await db.updateRoom(code, room.version, patch)) return { ...room, ...patch, version: room.version + 1 };
    }
    throw new UserError('요청이 몰려 처리하지 못했습니다. 다시 시도하세요.');
  }

  async function system(code, text) {
    await db.addMessage({ room_code: code, member_id: null, name: null, avatar: null, text, system: true });
  }

  async function loadGame(code) {
    const row = await db.loadGame(code);
    if (!row) throw new UserError('게임이 시작되지 않았습니다.');
    return { game: SixteenGame.fromJSON(row.state), version: row.version };
  }

  function handsOf(game, room) {
    return room.members
      .filter((m) => !m.isBot && m.userId)
      .map((m) => {
        const p = game.players.find((x) => x.id === m.id);
        return p ? { memberId: m.id, userId: m.userId, tiles: p.hand } : null;
      })
      .filter(Boolean);
  }

  async function commit(code, game, expected, room) {
    game.lastMoveAt = now();
    const status = game.phase === 'finished' ? 'finished' : 'playing';
    try {
      return await db.commitGame(code, expected, game.toJSON(), game.publicView(), handsOf(game, room), status);
    } catch (e) {
      if (e instanceof ConflictError) throw new UserError('다른 수가 먼저 처리되었습니다. 다시 시도하세요.');
      throw e;
    }
  }

  /** 게임 액션 공통: 최신 상태를 읽어 fn 적용 후 저장. */
  async function gameAction(userId, fn) {
    const room = await requireRoomOf(userId);
    const me = memberOf(room, userId);
    const { game, version } = await loadGame(room.code);
    const result = fn(game, me, room);
    await commit(room.code, game, version, room);
    return { code: room.code, result };
  }

  /** 사람 → 봇 대체 (게임 상태 + 방 멤버 둘 다). */
  async function replaceWithBot(code, memberId) {
    const row = await db.loadGame(code);
    let botName = null;
    await mutateRoom(code, (room) => {
      const m = room.members.find((x) => x.id === memberId);
      if (!m || m.isBot) return undefined;
      botName = `${m.name}(봇)`;
      m.formerUserId = m.userId;
      m.userId = null;
      m.isBot = true;
      m.replaced = true;
      m.name = botName;
      m.avatar = '🤖';
      const humans = room.members.filter((x) => !x.isBot);
      if (!humans.length) return null;
      if (room.host_id === m.formerUserId) room.host_id = humans[0].userId;
      return undefined;
    });
    if (row && botName) {
      const room = await db.getRoom(code);
      if (!room) return;
      const game = SixteenGame.fromJSON(row.state);
      game.setBot(memberId, true, botName);
      try {
        await db.commitGame(code, row.version, game.toJSON(), game.publicView(), handsOf(game, room), room.status);
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        // 동시에 진행된 수가 있으면 최신 상태로 한 번 더 시도
        const again = await db.loadGame(code);
        const g2 = SixteenGame.fromJSON(again.state);
        g2.setBot(memberId, true, botName);
        await db.commitGame(code, again.version, g2.toJSON(), g2.publicView(), handsOf(g2, room), room.status);
      }
    }
  }

  async function leave(userId) {
    const room = await db.findRoomByMember('userId', userId);
    if (!room) return {};
    const me = memberOf(room, userId);
    const playing = room.status === 'playing';
    if (playing) {
      await replaceWithBot(room.code, me.id);
      if (await db.getRoom(room.code)) await system(room.code, `${me.name}님이 나갔습니다. 봇이 대신 플레이합니다.`);
      return { code: room.code, runBots: true };
    }
    let newHost = null;
    const res = await mutateRoom(room.code, (r) => {
      r.members = r.members.filter((m) => m.userId !== userId);
      const humans = r.members.filter((m) => !m.isBot);
      if (!humans.length) return null;
      if (r.host_id === userId) {
        r.host_id = humans[0].userId;
        newHost = humans[0].name;
      }
      return undefined;
    });
    if (res) {
      await system(room.code, `${me.name}님이 나갔습니다.`);
      if (newHost) await system(room.code, `${newHost}님이 새 방장이 되었습니다.`);
    }
    return {};
  }

  /* ---------------- 액션 ---------------- */

  const actions = {
    /** 새로고침/재접속: 참여 중인 방을 찾고, 봇으로 대체된 자리가 있으면 되찾는다. */
    async resume(userId, { profile }) {
      const room = await db.findRoomByMember('userId', userId);
      if (room) {
        if (profile) await actions.profile(userId, { profile });
        return { code: room.code };
      }
      const old = await db.findRoomByMember('formerUserId', userId);
      if (old && old.status === 'playing' && profile) {
        const { name, avatar } = profileOf(profile);
        const member = old.members.find((m) => m.formerUserId === userId);
        await mutateRoom(old.code, (r) => {
          const m = r.members.find((x) => x.id === member.id);
          if (!m || !m.replaced) return undefined;
          Object.assign(m, { userId, name, avatar, isBot: false, replaced: false, formerUserId: null });
          return undefined;
        });
        const { game, version } = await loadGame(old.code);
        game.setBot(member.id, false, name);
        await commit(old.code, game, version, await db.getRoom(old.code));
        await system(old.code, `${name}님이 돌아왔습니다.`);
        return { code: old.code, reclaimed: true };
      }
      return { code: null };
    },

    async profile(userId, { profile }) {
      const { name, avatar } = profileOf(profile);
      const room = await db.findRoomByMember('userId', userId);
      if (!room) return {};
      await mutateRoom(room.code, (r) => {
        const m = memberOf(r, userId);
        if (!m || (m.name === name && m.avatar === avatar)) return undefined;
        m.name = name;
        m.avatar = avatar;
        return undefined;
      });
      return { code: room.code };
    },

    async create(userId, { profile, name, maxPlayers }) {
      const p = profileOf(profile);
      await leave(userId);
      await db.cleanup();
      for (let i = 0; i < 5; i++) {
        const code = newRoomCode();
        const ok = await db.insertRoom({
          code,
          name: clean(name, 30) || `${p.name}님의 식스틴`,
          host_id: userId,
          max_players: clamp(maxPlayers, MIN_PLAYERS, MAX_PLAYERS, 4),
          rounds: 1, // 공식 규칙: 한 판으로 승부
          status: 'waiting',
          members: [{ id: randomId(), userId, name: p.name, avatar: p.avatar, isBot: false }],
          version: 0,
        });
        if (ok) {
          await system(code, `${p.name}님이 방을 만들었습니다.`);
          return { code };
        }
      }
      throw new UserError('방을 만들지 못했습니다. 다시 시도하세요.');
    },

    async join(userId, { profile, code }) {
      const p = profileOf(profile);
      code = clean(code, 10).toUpperCase();
      const current = await db.findRoomByMember('userId', userId);
      if (current && current.code === code) return { code };
      if (!(await db.getRoom(code))) throw new UserError('방을 찾을 수 없습니다.');
      if (current) await leave(userId);
      await mutateRoom(code, (r) => {
        if (r.status === 'playing') throw new UserError('이미 게임이 진행 중인 방입니다.');
        if (r.members.length >= r.max_players) throw new UserError('방이 가득 찼습니다.');
        r.members.push({ id: randomId(), userId, name: p.name, avatar: p.avatar, isBot: false });
        return undefined;
      });
      await system(code, `${p.name}님이 입장했습니다.`);
      return { code };
    },

    async leave(userId) {
      return leave(userId);
    },

    async addBot(userId) {
      const room = await requireRoomOf(userId);
      requireHost(room, userId);
      let botName;
      await mutateRoom(room.code, (r) => {
        if (r.status === 'playing') throw new UserError('게임 중에는 봇을 추가할 수 없습니다.');
        if (r.members.length >= r.max_players) throw new UserError('방이 가득 찼습니다.');
        const used = new Set(r.members.map((m) => m.name));
        botName = BOT_NAMES.find((n) => !used.has(n)) || `봇${r.members.length + 1}`;
        r.members.push({ id: randomId(), userId: null, name: botName, avatar: '🤖', isBot: true });
        return undefined;
      });
      await system(room.code, `${botName}이(가) 참가했습니다.`);
      return { code: room.code };
    },

    async kick(userId, { id }) {
      const room = await requireRoomOf(userId);
      requireHost(room, userId);
      let kicked;
      await mutateRoom(room.code, (r) => {
        if (r.status === 'playing') throw new UserError('게임 중에는 내보낼 수 없습니다.');
        const idx = r.members.findIndex((m) => m.id === id && m.userId !== userId);
        if (idx < 0) throw new UserError('대상을 찾을 수 없습니다.');
        [kicked] = r.members.splice(idx, 1);
        return undefined;
      });
      await system(room.code, `${kicked.name}님이 퇴장되었습니다.`);
      return { code: room.code };
    },

    async settings(userId, { maxPlayers }) {
      const room = await requireRoomOf(userId);
      requireHost(room, userId);
      await mutateRoom(room.code, (r) => {
        if (r.status === 'playing') throw new UserError('게임 중에는 변경할 수 없습니다.');
        if (maxPlayers) r.max_players = clamp(maxPlayers, Math.max(MIN_PLAYERS, r.members.length), MAX_PLAYERS, r.max_players);
        return undefined;
      });
      return { code: room.code };
    },

    async start(userId) {
      const room = await requireRoomOf(userId);
      requireHost(room, userId);
      if (room.status === 'playing') throw new UserError('이미 게임이 진행 중입니다.');
      if (room.members.length < MIN_PLAYERS) throw new UserError(`최소 ${MIN_PLAYERS}명이 필요합니다. 봇을 추가해 보세요.`);
      if (room.members.length > MAX_PLAYERS) throw new UserError(`최대 ${MAX_PLAYERS}명까지 플레이할 수 있습니다.`);
      const game = new SixteenGame(room.members.map((m) => ({ id: m.id, name: m.name, isBot: m.isBot })));
      await commit(room.code, game, null, room);
      await system(room.code, '게임이 시작되었습니다! 행운을 빌어요 🍀');
      return { code: room.code, runBots: true };
    },

    async play(userId, { tileIds, row, count }) {
      const { code, result } = await gameAction(userId, (game, me) => game.play(
        me.id,
        (Array.isArray(tileIds) ? tileIds : []).map(Number),
        row ? String(row) : undefined,
        count == null ? undefined : Number(count),
      ));
      return { code, runBots: true, finished: result.finished };
    },

    async pass(userId) {
      const { code } = await gameAction(userId, (game, me) => game.pass(me.id));
      return { code, runBots: true };
    },

    async reset(userId) {
      const room = await requireRoomOf(userId);
      requireHost(room, userId);
      if (room.status !== 'finished') throw new UserError('게임이 끝난 후에만 가능합니다.');
      await db.clearGame(room.code);
      await mutateRoom(room.code, (r) => {
        r.members = r.members.filter((m) => !m.replaced);
        r.status = 'waiting';
        return undefined;
      });
      return { code: room.code };
    },

    /** 차례인 플레이어가 오래 응답하지 않으면(연결 끊김 등) 봇으로 대체한다. */
    async replace(userId, { id }) {
      const room = await requireRoomOf(userId);
      if (room.status !== 'playing') throw new UserError('게임 중에만 가능합니다.');
      const { game } = await loadGame(room.code);
      const target = room.members.find((m) => m.id === id);
      if (!target || target.isBot) throw new UserError('대상을 찾을 수 없습니다.');
      if (target.userId === userId) throw new UserError('자신은 대체할 수 없습니다. 나가기를 이용하세요.');
      if (game.players[game.current]?.id !== id) throw new UserError('현재 차례인 플레이어만 대체할 수 있습니다.');
      const waited = now() - (game.lastMoveAt || 0);
      if (waited < STALL_MS) throw new UserError(`${Math.ceil((STALL_MS - waited) / 1000)}초 후에 대체할 수 있습니다.`);
      await replaceWithBot(room.code, id);
      await system(room.code, `${target.name}님이 응답이 없어 봇으로 대체되었습니다.`);
      return { code: room.code, runBots: true };
    },

    async chat(userId, { text }) {
      const room = await requireRoomOf(userId);
      const me = memberOf(room, userId);
      const msg = clean(text, 200);
      if (!msg) return {};
      await db.addMessage({ room_code: room.code, member_id: me.id, name: me.name, avatar: me.avatar, text: msg, system: false });
      return { code: room.code };
    },
  };

  /**
   * 봇 차례가 끝날 때까지 봇의 수를 진행한다. 각 수마다 저장하므로
   * 클라이언트는 Realtime으로 한 수씩 보게 된다. 다른 요청과 충돌하면 멈춘다
   * (그 요청이 이어서 봇을 진행한다).
   */
  async function runBots(code, maxSteps = 200) {
    for (let step = 0; step < maxSteps; step++) {
      const row = await db.loadGame(code);
      if (!row) return;
      const game = SixteenGame.fromJSON(row.state);
      if (game.phase !== 'playing' || !game.players[game.current].isBot) return;
      await sleep(botDelay);
      const fresh = await db.loadGame(code);
      if (!fresh || fresh.version !== row.version) continue;
      const room = await db.getRoom(code);
      if (!room) return;
      const id = game.players[game.current].id;
      const move = botMove(game, id);
      if (move.action === 'play') game.play(id, move.tileIds, move.row, move.count);
      else game.pass(id);
      game.lastMoveAt = now();
      const status = game.phase === 'finished' ? 'finished' : 'playing';
      try {
        await db.commitGame(code, row.version, game.toJSON(), game.publicView(), handsOf(game, room), status);
      } catch (e) {
        if (e instanceof ConflictError) return;
        throw e;
      }
    }
  }

  async function handle(userId, action, payload = {}) {
    if (!userId) throw new UserError('로그인이 필요합니다.');
    const fn = Object.prototype.hasOwnProperty.call(actions, action) && actions[action];
    if (!fn) throw new UserError('알 수 없는 요청입니다.');
    try {
      return (await fn(userId, payload || {})) || {};
    } catch (e) {
      // 게임 엔진의 규칙 위반 메시지(Error)는 사용자에게 그대로 전달한다.
      if (e instanceof RuleError) throw new UserError(e.message);
      throw e;
    }
  }

  return { handle, runBots, actions };
}
