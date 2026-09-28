-- 식스틴 온라인: 테이블, 보안 정책(RLS), Realtime 설정
--
-- 모든 쓰기는 Edge Function(`sixteen`)이 service role로 수행한다.
-- 브라우저(anon/authenticated)는 읽기만 가능하며, 손패(hands)는 본인 것만 읽을 수 있다.

-- 방 (로비 목록)
create table public.rooms (
  code         text primary key,
  name         text not null,
  host_id      uuid not null,
  max_players  int  not null default 4 check (max_players between 2 and 5),
  rounds       int  not null default 3 check (rounds between 1 and 10),
  status       text not null default 'waiting' check (status in ('waiting', 'playing', 'finished')),
  -- [{ id, userId, name, avatar, isBot, replaced?, formerUserId? }]
  members      jsonb not null default '[]'::jsonb,
  version      int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index rooms_members_idx on public.rooms using gin (members jsonb_path_ops);

-- 공개 게임 상태 (테이블 위 타일, 각자 남은 타일 수, 점수, 기록)
create table public.games (
  room_code   text primary key references public.rooms (code) on delete cascade,
  version     int not null,
  view        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- 전체 게임 상태 (모든 손패와 뽑기 더미 포함) — 클라이언트는 접근 불가
create table public.game_secrets (
  room_code   text primary key references public.rooms (code) on delete cascade,
  version     int not null default 1,
  state       jsonb not null
);

-- 플레이어별 손패 — 본인만 읽을 수 있음 (가림막)
create table public.hands (
  room_code   text not null references public.rooms (code) on delete cascade,
  member_id   text not null,
  user_id     uuid,
  tiles       jsonb not null default '[]'::jsonb,
  version     int not null default 0,
  primary key (room_code, member_id)
);
create index hands_user_idx on public.hands (user_id);

-- 채팅 및 시스템 메시지
create table public.messages (
  id          bigint generated always as identity primary key,
  room_code   text not null references public.rooms (code) on delete cascade,
  member_id   text,
  name        text,
  avatar      text,
  text        text not null check (char_length(text) <= 200),
  system      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index messages_room_idx on public.messages (room_code, id desc);

-- ---------------------------------------------------------------------------
-- 테이블 권한 (프로젝트의 "Automatically expose new tables" 설정과 무관하게 동작하도록 명시)
-- 브라우저(anon/authenticated)는 읽기만, 쓰기는 service role(Edge Function)만.
-- ---------------------------------------------------------------------------
revoke all on public.rooms, public.games, public.game_secrets, public.hands, public.messages from anon, authenticated;
grant select on public.rooms, public.games, public.hands, public.messages to anon, authenticated;
grant all on public.rooms, public.games, public.game_secrets, public.hands, public.messages to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.rooms        enable row level security;
alter table public.games        enable row level security;
alter table public.game_secrets enable row level security;
alter table public.hands        enable row level security;
alter table public.messages     enable row level security;

create policy "rooms are public"    on public.rooms    for select to anon, authenticated using (true);
create policy "games are public"    on public.games    for select to anon, authenticated using (true);
create policy "messages are public" on public.messages for select to anon, authenticated using (true);
create policy "own hand only"       on public.hands    for select to authenticated using (user_id = (select auth.uid()));
-- game_secrets: 정책 없음 → service role 외에는 접근 불가

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.rooms, public.games, public.hands, public.messages;

-- ---------------------------------------------------------------------------
-- 게임 상태 저장 (원자적 + 버전 확인으로 동시 수 처리 방지)
-- p_expected 가 null 이면 새 게임 시작.
-- p_hands: [{ memberId, userId, tiles }]
-- ---------------------------------------------------------------------------
create or replace function public.sixteen_commit_game(
  p_room text, p_expected int, p_state jsonb, p_view jsonb, p_hands jsonb, p_status text
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v int;
begin
  if p_expected is null then
    insert into public.game_secrets as s (room_code, state, version)
      values (p_room, p_state, 1)
      on conflict (room_code) do update set state = excluded.state, version = s.version + 1
      returning s.version into v;
  else
    update public.game_secrets set state = p_state, version = version + 1
      where room_code = p_room and version = p_expected
      returning version into v;
    if v is null then
      raise exception 'version conflict' using errcode = '40001';
    end if;
  end if;

  insert into public.games (room_code, version, view, updated_at)
    values (p_room, v, p_view, now())
    on conflict (room_code) do update
      set version = excluded.version, view = excluded.view, updated_at = now();

  delete from public.hands h
    where h.room_code = p_room
      and not exists (select 1 from jsonb_array_elements(p_hands) x where x ->> 'memberId' = h.member_id);

  insert into public.hands (room_code, member_id, user_id, tiles, version)
    select p_room, x ->> 'memberId', (x ->> 'userId')::uuid, x -> 'tiles', v
    from jsonb_array_elements(p_hands) x
    on conflict (room_code, member_id) do update
      set user_id = excluded.user_id, tiles = excluded.tiles, version = excluded.version
      where public.hands.tiles is distinct from excluded.tiles
         or public.hands.user_id is distinct from excluded.user_id;

  update public.rooms
    set status = p_status, version = version + 1, updated_at = now()
    where code = p_room and status is distinct from p_status;

  return v;
end;
$$;

-- 3시간 이상 활동이 없는 방 정리
create or replace function public.sixteen_cleanup() returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.rooms r
  where r.updated_at < now() - interval '3 hours'
    and not exists (
      select 1 from public.games g
      where g.room_code = r.code and g.updated_at > now() - interval '3 hours'
    );
$$;

revoke all on function public.sixteen_commit_game(text, int, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.sixteen_cleanup() from public, anon, authenticated;
grant execute on function public.sixteen_commit_game(text, int, jsonb, jsonb, jsonb, text) to service_role;
grant execute on function public.sixteen_cleanup() to service_role;
