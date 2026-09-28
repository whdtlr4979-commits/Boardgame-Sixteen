// 실제 Supabase(로컬 `supabase start` 또는 원격 프로젝트)에 대해 전체 흐름과 보안 정책을 검증한다.
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run test:e2e
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { legalMoves } from '../supabase/functions/_shared/game.js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;

async function player(name) {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  const call = async (action, payload = {}) => {
    const { data: res, error: err } = await sb.functions.invoke('sixteen', { body: { action, ...payload } });
    if (err) throw new Error(`${action}: ${err.message} ${await err.context?.text?.()}`);
    return res;
  };
  return { sb, id: data.user.id, call, profile: { name, avatar: '🦊' } };
}

const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 200));
  }
};

test('Supabase: 방 → 게임 → Realtime → 보안 정책', { skip: !URL || !KEY, timeout: 120000 }, async () => {
  const a = await player('앨리스');
  const b = await player('밥');

  const created = await a.call('create', { profile: a.profile, name: 'e2e', maxPlayers: 3 });
  assert.equal(created.ok, true, JSON.stringify(created));
  const code = created.code;
  assert.equal((await b.call('join', { profile: b.profile, code })).ok, true);
  assert.equal((await b.call('start')).ok, false, '방장만 시작 가능');
  assert.equal((await a.call('addBot')).ok, true);

  // Realtime: b 가 games 변경을 구독
  const events = [];
  const ch = b.sb.channel(`t:${code}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `room_code=eq.${code}` }, (p) => events.push(p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'hands', filter: `room_code=eq.${code}` }, (p) => events.push(p));
  await new Promise((resolve) => ch.subscribe((s) => s === 'SUBSCRIBED' && resolve()));

  assert.equal((await a.call('start')).ok, true);
  await until(() => events.some((e) => e.table === 'games'));
  await until(() => events.some((e) => e.table === 'hands'));
  assert.ok(events.filter((e) => e.table === 'hands').every((e) => e.new.user_id === b.id), 'Realtime 으로 남의 손패가 오면 안 됨');

  // RLS: 손패는 자기 것만, game_secrets 는 접근 불가, 직접 쓰기 불가
  const bHands = await b.sb.from('hands').select('*').eq('room_code', code);
  assert.equal(bHands.data.length, 1);
  assert.equal(bHands.data[0].user_id, b.id);
  const secrets = await b.sb.from('game_secrets').select('*').eq('room_code', code);
  assert.deepEqual(secrets.data ?? [], []);
  const hack = await b.sb.from('rooms').update({ host_id: b.id }).eq('code', code).select();
  assert.deepEqual(hack.data ?? [], []);
  assert.equal((await b.sb.from('rooms').select('host_id').eq('code', code).single()).data.host_id, a.id);
  const rpc = await b.sb.rpc('sixteen_commit_game', { p_room: code, p_expected: 1, p_state: {}, p_view: {}, p_hands: [], p_status: 'playing' });
  assert.ok(rpc.error, 'commit 함수는 클라이언트가 호출할 수 없음');
  const msg = await b.sb.from('messages').insert({ room_code: code, text: 'spoof', name: '앨리스' });
  assert.ok(msg.error, '메시지 직접 삽입 불가');

  const view = (await b.sb.from('games').select('view').eq('room_code', code).single()).data.view;
  assert.equal(view.players.length, 3);
  assert.ok(view.players.every((p) => !('hand' in p)));

  // 끝까지 플레이 (사람은 가능한 첫 번째 수, 없으면 패스)
  const room = (await a.sb.from('rooms').select('members').eq('code', code).single()).data;
  const byMember = Object.fromEntries(room.members.filter((m) => m.userId).map((m) => [m.id, m.userId === a.id ? a : b]));
  let finished = false;
  for (let i = 0; i < 600 && !finished; i++) {
    const g = (await a.sb.from('games').select('view').eq('room_code', code).single()).data.view;
    if (g.phase === 'finished') { finished = true; break; }
    const cur = g.players[g.current];
    const p = byMember[cur.id];
    if (!p) { await new Promise((r) => setTimeout(r, 150)); continue; } // 봇 차례: 서버가 진행
    const hand = (await p.sb.from('hands').select('tiles').eq('room_code', code).single()).data.tiles;
    const moves = legalMoves(g.rows, hand);
    const res = moves.length ? await p.call('play', moves[0]) : await p.call('pass');
    if (!res.ok && !/차례|먼저/.test(res.error)) assert.fail(res.error);
  }
  assert.ok(finished, '게임이 끝나야 함');
  assert.equal((await a.sb.from('rooms').select('status').eq('code', code).single()).data.status, 'finished');

  // 채팅
  assert.equal((await b.call('chat', { text: '잘 했어요!' })).ok, true);
  const chat = await a.sb.from('messages').select('*').eq('room_code', code).eq('system', false);
  assert.equal(chat.data.at(-1).name, '밥');

  // 나가기 → 방 정리
  await b.call('leave');
  await a.call('leave');
  assert.equal((await a.sb.from('rooms').select('code').eq('code', code)).data.length, 0);
  await a.sb.removeAllChannels();
  await b.sb.removeAllChannels();
});
