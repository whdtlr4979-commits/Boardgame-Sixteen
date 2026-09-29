// 식스틴 온라인 — Supabase Edge Function
// 브라우저는 supabase.functions.invoke('sixteen', { body: { action, ...payload } }) 로 호출한다.
import { createClient } from '@supabase/supabase-js';
import { ConflictError, UserError, createCore } from '../_shared/core.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// 봇이 한 수를 두기 전 기다리는 시간(ms). '3000-5000' 처럼 범위를 주면 그 사이에서 무작위로 고른다.
const BOT_DELAY = (Deno.env.get('BOT_DELAY_MS') ?? '3000-5000').split('-').map(Number);
const BOT_DELAY_MS = BOT_DELAY.length > 1 ? [BOT_DELAY[0], BOT_DELAY[1]] : BOT_DELAY[0];

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function check<T>({ data, error }: { data: T; error: unknown }): T {
  if (error) throw error;
  return data;
}

/** core.js 가 사용하는 DB 어댑터 (Supabase 구현) */
const db = {
  async getRoom(code: string) {
    return check(await admin.from('rooms').select('*').eq('code', code).maybeSingle());
  },
  async findRoomByMember(field: 'userId' | 'formerUserId', userId: string) {
    const rows = check(
      await admin.from('rooms').select('*')
        .contains('members', JSON.stringify([{ [field]: userId }]))
        .order('updated_at', { ascending: false })
        .limit(1),
    );
    return rows?.[0] ?? null;
  },
  async insertRoom(room: Record<string, unknown>) {
    const { error } = await admin.from('rooms').insert(room);
    if (error?.code === '23505') return false; // 코드 중복
    if (error) throw error;
    return true;
  },
  async updateRoom(code: string, version: number, patch: Record<string, unknown>) {
    const rows = check(
      await admin.from('rooms')
        .update({ ...patch, version: version + 1, updated_at: new Date().toISOString() })
        .eq('code', code).eq('version', version)
        .select('code'),
    );
    return rows.length === 1;
  },
  async deleteRoom(code: string) {
    check(await admin.from('rooms').delete().eq('code', code));
  },
  async loadGame(code: string) {
    return check(await admin.from('game_secrets').select('state, version').eq('room_code', code).maybeSingle());
  },
  async commitGame(code: string, expected: number | null, state: unknown, view: unknown, hands: unknown, status: string) {
    const { data, error } = await admin.rpc('sixteen_commit_game', {
      p_room: code, p_expected: expected, p_state: state, p_view: view, p_hands: hands, p_status: status,
    });
    if (error?.code === '40001') throw new ConflictError('version conflict');
    if (error) throw error;
    return data as number;
  },
  async clearGame(code: string) {
    check(await admin.from('game_secrets').delete().eq('room_code', code));
    check(await admin.from('games').delete().eq('room_code', code));
    check(await admin.from('hands').delete().eq('room_code', code));
  },
  async addMessage(msg: Record<string, unknown>) {
    check(await admin.from('messages').insert(msg));
  },
  async cleanup() {
    check(await admin.rpc('sixteen_cleanup'));
  },
};

const core = createCore(db, { botDelay: BOT_DELAY_MS });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST만 지원합니다.' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth?.user) return json({ ok: false, error: '로그인이 필요합니다. 새로고침해 주세요.' }, 401);

  let body: { action?: string; [k: string]: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: '잘못된 요청입니다.' }, 400);
  }

  try {
    const { runBots, ...result } = await core.handle(auth.user.id, String(body.action ?? ''), body);
    if (runBots && result.code) {
      // 봇 차례는 응답을 돌려준 뒤 백그라운드에서 진행한다 (결과는 Realtime으로 전달).
      const task = core.runBots(result.code).catch((e: unknown) => console.error('runBots', e));
      // @ts-ignore EdgeRuntime 은 Supabase Edge Runtime 전역 객체
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(task);
      else await task;
    }
    return json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof UserError) return json({ ok: false, error: e.message });
    console.error(e);
    return json({ ok: false, error: '서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.' }, 500);
  }
});
