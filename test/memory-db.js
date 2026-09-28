// core.js 테스트용 메모리 DB 어댑터 (sixteen_commit_game 과 같은 의미를 흉내 낸다)
import { ConflictError } from '../supabase/functions/_shared/core.js';

const clone = (x) => (x == null ? x : structuredClone(x));

export function createMemoryDb() {
  const rooms = new Map();
  const secrets = new Map();
  const games = new Map();
  const hands = new Map(); // `${code}:${memberId}` -> row
  const messages = [];

  return {
    rooms, secrets, games, hands, messages,
    async getRoom(code) { return clone(rooms.get(code) || null); },
    async findRoomByMember(field, userId) {
      for (const r of rooms.values()) if (r.members.some((m) => m[field] === userId)) return clone(r);
      return null;
    },
    async insertRoom(room) {
      if (rooms.has(room.code)) return false;
      rooms.set(room.code, clone({ ...room, created_at: Date.now(), updated_at: Date.now() }));
      return true;
    },
    async updateRoom(code, version, patch) {
      const r = rooms.get(code);
      if (!r || r.version !== version) return false;
      rooms.set(code, clone({ ...r, ...patch, version: version + 1, updated_at: Date.now() }));
      return true;
    },
    async deleteRoom(code) {
      rooms.delete(code);
      secrets.delete(code);
      games.delete(code);
      for (const k of [...hands.keys()]) if (k.startsWith(code + ':')) hands.delete(k);
    },
    async loadGame(code) { return clone(secrets.get(code) || null); },
    async commitGame(code, expected, state, view, handRows, status) {
      const cur = secrets.get(code);
      let v;
      if (expected == null) v = (cur?.version || 0) + 1;
      else {
        if (!cur || cur.version !== expected) throw new ConflictError('version conflict');
        v = expected + 1;
      }
      secrets.set(code, clone({ state, version: v }));
      games.set(code, clone({ version: v, view }));
      for (const k of [...hands.keys()]) if (k.startsWith(code + ':')) hands.delete(k);
      for (const h of handRows) hands.set(`${code}:${h.memberId}`, clone({ ...h, version: v }));
      const r = rooms.get(code);
      if (r && r.status !== status) rooms.set(code, { ...r, status, version: r.version + 1 });
      return v;
    },
    async clearGame(code) {
      secrets.delete(code);
      games.delete(code);
      for (const k of [...hands.keys()]) if (k.startsWith(code + ':')) hands.delete(k);
    },
    async addMessage(msg) { messages.push(clone(msg)); },
    async cleanup() {},
  };
}
