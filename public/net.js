/* global supabase */
/**
 * Supabase 연결 계층: 익명 로그인, Edge Function 호출, Realtime 구독, Presence.
 * app.js 는 이 모듈이 넘겨주는 콜백만으로 화면을 그린다.
 */

const LOBBY_LIMIT = 50;

/** 익명 로그인 실패 원인별 안내 문구 */
function signInHint(error) {
  const msg = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  if (/anonymous.*disabled|anonymous_provider_disabled/.test(msg)) return 'Authentication → Sign In / Providers 에서 Allow anonymous sign-ins 를 켜고 Save changes 를 누르세요';
  if (/signups? not allowed|signup_disabled/.test(msg)) return 'Allow new users to sign up 을 켜 주세요';
  if (/invalid api key|no api key|jwt|apikey/.test(msg)) return 'config.js 의 supabaseAnonKey 값을 확인하세요';
  if (/captcha/.test(msg)) return 'CAPTCHA 가 켜져 있으면 익명 로그인이 막힙니다 (Attack Protection 설정 확인)';
  if (/rate limit|too many/.test(msg)) return '잠시 후 다시 시도하거나 Authentication → Rate Limits 를 늘리세요';
  if (/fetch|network|load failed/.test(msg)) return 'config.js 의 supabaseUrl 값을 확인하세요';
  return 'Supabase 설정과 config.js 값을 확인하세요';
}

export function createNet(config, handlers) {
  // 'https://xxx.supabase.co/rest/v1/' 처럼 API 경로까지 붙여 넣어도 동작하도록 기본 주소만 남긴다.
  const url = String(config.supabaseUrl).trim().replace(/\/(rest|auth|functions|realtime)\/v1\/?.*$/, '').replace(/\/+$/, '');
  const sb = supabase.createClient(url, String(config.supabaseAnonKey).trim(), {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sixteen.auth' },
  });

  let userId = null;
  let profile = null;
  let lobbyRooms = [];
  let presence = [];
  let presenceChannel = null;
  let roomChannel = null;
  let roomCode = null;
  let roomState = null; // { room, game: {version, view}, hand: {version, tiles}, messages }

  /* ---------------- 인증 ---------------- */

  async function ensureSession() {
    const { data } = await sb.auth.getSession();
    let session = data.session;
    if (!session) {
      const res = await sb.auth.signInAnonymously();
      if (res.error) throw new Error(`익명 로그인 실패: ${res.error.message} (${signInHint(res.error)})`);
      session = res.data.session;
    }
    userId = session.user.id;
    return userId;
  }

  /* ---------------- Edge Function 호출 ---------------- */

  async function call(action, payload = {}) {
    const { data, error } = await sb.functions.invoke('sixteen', { body: { action, ...payload } });
    if (error) {
      let message = '서버에 연결할 수 없습니다.';
      try {
        const body = await error.context.json();
        if (body?.error) message = body.error;
      } catch { /* 본문 없음 */ }
      return { ok: false, error: message };
    }
    if (data?.ok) {
      if (['create', 'join', 'resume'].includes(action)) {
        if (data.code) await enterRoom(data.code);
        else exitRoom();
      } else if (action === 'leave') exitRoom();
    }
    return data || { ok: false, error: '응답이 없습니다.' };
  }

  /* ---------------- 로비 ---------------- */

  let lobbyTimer = null;
  async function refreshLobby() {
    const { data, error } = await sb.from('rooms').select('*')
      .order('created_at', { ascending: false }).limit(LOBBY_LIMIT);
    if (error) return;
    lobbyRooms = data;
    emitLobby();
  }
  const refreshLobbySoon = () => {
    clearTimeout(lobbyTimer);
    lobbyTimer = setTimeout(refreshLobby, 250);
  };

  function emitLobby() {
    // 접속 중인 사람이 한 명도 없는 방(버려진 방)은 로비에서 숨긴다. 서버 쪽 정리는 sixteen_cleanup().
    const alive = (r) => r.code === roomCode || r.members.some((m) => m.userId && isOnline(m.userId));
    handlers.onLobby({
      rooms: lobbyRooms.filter(alive).map(summarize),
      online: presence.map((p) => ({ name: p.name, avatar: p.avatar, inRoom: !!p.room, userId: p.userId })),
    });
  }

  function summarize(r) {
    const host = r.members.find((m) => m.userId === r.host_id);
    return {
      code: r.code,
      name: r.name,
      host: host ? host.name : '',
      hostAvatar: host ? host.avatar : '🎲',
      members: r.members.map((m) => ({ name: m.name, avatar: m.avatar, isBot: m.isBot })),
      maxPlayers: r.max_players,
      rounds: r.rounds,
      status: r.status,
      createdAt: Date.parse(r.created_at),
    };
  }

  function subscribeLobby() {
    sb.channel('lobby')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, (payload) => {
        refreshLobbySoon();
        if (!roomState) return;
        if (payload.eventType === 'DELETE' && payload.old?.code === roomCode) {
          exitRoom();
          handlers.onKicked('방이 닫혔습니다.');
        } else if (payload.new?.code === roomCode) {
          applyRoom(payload.new);
        }
      })
      .subscribe((status) => { if (status === 'SUBSCRIBED') refreshLobby(); });
  }

  /* ---------------- Presence (접속자) ---------------- */

  function subscribePresence() {
    presenceChannel = sb.channel('online', { config: { presence: { key: userId } } });
    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        const st = presenceChannel.presenceState();
        presence = Object.entries(st).map(([key, metas]) => ({ userId: key, ...metas[metas.length - 1] }));
        emitLobby();
        if (roomState) emitRoom();
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await trackPresence();
      });
  }

  async function trackPresence() {
    if (!presenceChannel || !profile) return;
    await presenceChannel.track({ name: profile.name, avatar: profile.avatar, room: roomCode });
  }

  const isOnline = (uid) => presence.some((p) => p.userId === uid);

  /* ---------------- 방 ---------------- */

  async function enterRoom(code) {
    if (roomCode === code && roomChannel) {
      await loadRoom(code);
      return;
    }
    exitRoom();
    roomCode = code;
    roomState = { room: null, game: null, hand: null, messages: [] };
    const filter = `room_code=eq.${code}`;
    roomChannel = sb.channel(`room:${code}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter }, (p) => {
        if (p.new?.view && (!roomState.game || p.new.version >= roomState.game.version)) {
          roomState.game = { version: p.new.version, view: p.new.view };
          emitRoom();
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hands', filter }, (p) => {
        if (p.new?.user_id === userId && (!roomState.hand || p.new.version >= roomState.hand.version)) {
          roomState.hand = { version: p.new.version, tiles: p.new.tiles };
          emitRoom();
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter }, (p) => {
        if (roomState.messages.some((m) => m.id === p.new.id)) return;
        roomState.messages.push(p.new);
        roomState.messages = roomState.messages.slice(-100);
        emitRoom();
      })
      .subscribe((status) => {
        // (재)연결될 때마다 최신 상태를 다시 읽어 놓친 변경을 보정한다.
        if (status === 'SUBSCRIBED') loadRoom(code);
      });
    await trackPresence();
    await loadRoom(code);
  }

  async function loadRoom(code) {
    const [room, game, hand, msgs] = await Promise.all([
      sb.from('rooms').select('*').eq('code', code).maybeSingle(),
      sb.from('games').select('version, view').eq('room_code', code).maybeSingle(),
      sb.from('hands').select('version, tiles').eq('room_code', code).eq('user_id', userId).maybeSingle(),
      sb.from('messages').select('*').eq('room_code', code).order('id', { ascending: false }).limit(80),
    ]);
    if (roomCode !== code) return;
    if (!room.data) {
      exitRoom();
      handlers.onKicked('방을 찾을 수 없습니다.');
      return;
    }
    roomState.game = game.data || null;
    roomState.hand = hand.data || null;
    const known = new Map(roomState.messages.map((m) => [m.id, m]));
    for (const m of msgs.data || []) known.set(m.id, m);
    roomState.messages = [...known.values()].sort((a, b) => a.id - b.id).slice(-100);
    applyRoom(room.data);
  }

  function applyRoom(row) {
    if (!roomState) return;
    if (roomState.room && row.version < roomState.room.version) return;
    const wasMember = roomState.room?.members.some((m) => m.userId === userId);
    roomState.room = row;
    if (!row.members.some((m) => m.userId === userId)) {
      exitRoom();
      handlers.onKicked(wasMember ? '방에서 퇴장되었습니다.' : '방에 참여하지 않았습니다.');
      return;
    }
    if (row.status === 'waiting') {
      roomState.game = null;
      roomState.hand = null;
    }
    emitRoom();
  }

  function exitRoom() {
    const left = roomCode;
    if (roomChannel) sb.removeChannel(roomChannel);
    roomChannel = null;
    roomCode = null;
    roomState = null;
    if (left) forgetMembership(left);
    trackPresence();
  }

  /**
   * 서버 변경이 실시간으로 도착하기 전에 로비 목록에서 내 자리를 먼저 뺀다.
   * (그러지 않으면 방금 나간 방이 로비에 잠깐 보였다가 사라진다)
   */
  function forgetMembership(code) {
    lobbyRooms = lobbyRooms.flatMap((r) => {
      if (r.code !== code) return [r];
      // 게임 중에 나가면 봇이 내 자리를 대신하고, 대기 중이면 자리가 빠진다
      const members = r.status === 'playing'
        ? r.members.map((m) => (m.userId === userId ? { ...m, userId: null, isBot: true } : m))
        : r.members.filter((m) => m.userId !== userId);
      return members.some((m) => !m.isBot) ? [{ ...r, members }] : [];
    });
    emitLobby();
  }

  function emitRoom() {
    const { room, game, hand, messages } = roomState;
    if (!room) return;
    const me = room.members.find((m) => m.userId === userId);
    const view = room.status !== 'waiting' && game ? game.view : null;
    const summary = summarize(room);
    handlers.onRoom({
      ...summary,
      you: me?.id,
      isHost: room.host_id === userId,
      memberList: room.members.map((m) => ({
        id: m.id,
        name: m.name,
        avatar: m.avatar,
        isBot: m.isBot,
        isHost: !!m.userId && m.userId === room.host_id,
        online: m.isBot || isOnline(m.userId),
      })),
      chat: messages.map((m) => ({
        id: m.id,
        system: m.system,
        text: m.text,
        t: Date.parse(m.created_at),
        from: m.system ? null : { id: m.member_id, name: m.name, avatar: m.avatar },
      })),
      game: view ? { ...view, hand: hand ? hand.tiles : null } : null,
    });
  }

  /* ---------------- 시작 ---------------- */

  async function start(initialProfile) {
    profile = initialProfile;
    await ensureSession();
    subscribeLobby();
    subscribePresence();
    return userId;
  }

  async function setProfile(p) {
    profile = p;
    await trackPresence();
  }

  return { start, call, setProfile, refreshLobby, get userId() { return userId; }, get roomCode() { return roomCode; } };
}
