import * as Sixteen from './game.js';
import { createNet } from './net.js';

{

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  };

  const state = {
    me: null,
    avatars: ['🦊', '🐼', '🐯', '🐨', '🐸', '🐙', '🦄', '🐧', '🦁', '🐰', '🐻', '🐳'],
    lobby: { rooms: [], online: [] },
    room: null,
    view: 'home',
    filter: 'all',
    selected: new Set(),
    prevHandIds: null,
    newIds: new Set(),
    lastChatSeen: 0,
    chatOpen: false,
    tab: 'chat',
    shownRoundResult: null,
  };

  /* ---------------- 테마 ---------------- */
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t;
    const dark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    $('meta[name="theme-color"]').content = dark ? '#000000' : '#ffffff';
  }
  function toggleTheme() {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    store.set('sixteen.theme', next);
    applyTheme(next);
  }
  applyTheme(store.get('sixteen.theme'));
  $('#themeToggle').onclick = toggleTheme;
  $('#themeToggle2').onclick = toggleTheme;

  /* ---------------- 토스트 & 모달 ---------------- */
  function toast(msg, err = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.textContent = msg;
    $('#toasts').append(el);
    while ($('#toasts').children.length > 3) $('#toasts').firstElementChild.remove();
    setTimeout(() => el.remove(), 2600);
  }

  function openModal(html, { wide = false, dismissable = true } = {}) {
    const box = $('#modalBox');
    box.className = 'modal' + (wide ? ' wide' : '');
    box.innerHTML = html;
    $('#modal').hidden = false;
    $('#modal').onclick = (e) => { if (dismissable && e.target.id === 'modal') closeModal(); };
    $$('[data-close]', box).forEach((b) => (b.onclick = closeModal));
    const first = $('input, select', box);
    if (first) setTimeout(() => first.focus(), 50);
    return box;
  }
  function closeModal() { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden && $('[data-close]', $('#modalBox'))) closeModal();
  });

  const STALL_MS = 60_000;
  const closeBtn = '<button class="icon-btn" data-close aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';

  /* ---------------- Supabase 연결 ---------------- */
  const config = window.SIXTEEN_CONFIG || {};
  const configured = !!(config.supabaseUrl && config.supabaseAnonKey && !/YOUR_/.test(config.supabaseUrl + config.supabaseAnonKey));
  let net = null;

  async function emit(action, payload = {}) {
    if (!net) {
      showSetup();
      return { ok: false };
    }
    let res;
    try {
      res = await net.call(action, payload);
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res.ok) toast(res.error || '요청에 실패했습니다.', true);
    return res;
  }

  function onKicked(msg) {
    toast(msg, true);
    state.room = null;
    state.shownRoundResult = null;
    $('#navGame').hidden = true;
    $('#tabGame').hidden = true;
    if (state.view === 'game') go('home');
  }

  async function boot() {
    if (!configured) return showSetup();
    net = createNet(config, {
      onLobby: (data) => { state.lobby = data; renderLobby(); },
      onRoom: (room) => onRoom(room),
      onKicked,
    });
    const name = store.get('sixteen.name');
    if (name) await hello(name, store.get('sixteen.avatar'));
    else showLogin();
  }

  async function hello(name, avatar) {
    name = String(name || '').trim().slice(0, 12);
    if (!name) { toast('닉네임을 입력하세요.', true); return false; }
    if (!state.avatars.includes(avatar)) avatar = state.avatars[Math.floor(Math.random() * state.avatars.length)];
    state.me = { name, avatar };
    store.set('sixteen.name', name);
    store.set('sixteen.avatar', avatar);
    renderMe();
    try {
      if (!net.userId) await net.start(state.me);
      else await net.setProfile(state.me);
    } catch (e) {
      toast(e.message, true);
      return false;
    }
    renderLobby();
    const res = await emit('resume', { profile: state.me });
    if (res.ok && res.reclaimed) toast('진행 중이던 게임으로 돌아왔습니다 🎮');
    if (res.ok && !res.code) {
      state.room = null;
      const invite = new URLSearchParams(location.search).get('room');
      if (invite) {
        history.replaceState(null, '', location.pathname);
        const j = await emit('join', { code: invite, profile: state.me });
        if (j.ok) go('game');
      } else if (state.view === 'game') go('home');
    }
    return true;
  }

  function showSetup() {
    openModal(`
      <div class="modal-body login">
        <span class="brand-text">Sixteen</span>
        <p>Supabase 연결 설정이 필요합니다</p>
        <div class="rules" style="text-align:left">
          <p><code>public/config.js</code> 파일에 Supabase 프로젝트의 <b>Project URL</b>과 <b>anon(public) key</b>를 입력하세요.</p>
          <p class="note">Supabase 대시보드 → Project Settings → API 에서 확인할 수 있습니다. 자세한 설정 방법은 README를 참고하세요.</p>
        </div>
      </div>`, { dismissable: false });
  }

  /* ---------------- 로그인 / 프로필 ---------------- */
  function avatarPicker(selected) {
    return `<div class="avatar-pick">${state.avatars.map((a) =>
      `<button type="button" data-av="${a}" class="${a === selected ? 'on' : ''}">${a}</button>`).join('')}</div>`;
  }
  function bindAvatarPicker(box) {
    $$('[data-av]', box).forEach((b) => (b.onclick = () => {
      $$('[data-av]', box).forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    }));
  }

  function showLogin() {
    const pick = store.get('sixteen.avatar') || state.avatars[Math.floor(Math.random() * state.avatars.length)];
    const box = openModal(`
      <div class="modal-body login">
        <span class="brand-text">Sixteen</span>
        <p>친구들과 실시간으로 즐기는 숫자 타일 게임</p>
        <form id="loginForm">
          <input class="input" id="loginName" placeholder="닉네임 (최대 12자)" maxlength="12" value="${esc(store.get('sixteen.name') || '')}" required />
          ${avatarPicker(pick)}
          <button class="btn primary block" type="submit">시작하기</button>
        </form>
        <div class="divider">또는</div>
        <button class="link-btn" id="loginRules">게임 규칙 먼저 보기</button>
      </div>`, { dismissable: false });
    bindAvatarPicker(box);
    $('#loginRules', box).onclick = () => showRules(showLogin);
    $('#loginForm', box).onsubmit = async (e) => {
      e.preventDefault();
      const av = ($('.avatar-pick .on', box) || {}).dataset?.av;
      if (await hello($('#loginName', box).value, av)) closeModal();
    };
  }

  function showProfile() {
    if (!state.me) return showLogin();
    const box = openModal(`
      <div class="modal-head">프로필 편집${closeBtn}</div>
      <div class="modal-body">
        <form id="profileForm">
          <div class="field"><label class="lbl">닉네임</label>
            <input class="input" id="pfName" maxlength="12" value="${esc(state.me.name)}" required /></div>
          <label class="lbl">아바타</label>
          ${avatarPicker(state.me.avatar)}
          <div class="modal-actions"><button class="btn" type="button" data-close>취소</button><button class="btn primary" type="submit">저장</button></div>
        </form>
      </div>`);
    bindAvatarPicker(box);
    $('#profileForm', box).onsubmit = async (e) => {
      e.preventDefault();
      const av = ($('.avatar-pick .on', box) || {}).dataset?.av;
      if (await hello($('#pfName', box).value, av)) { closeModal(); toast('프로필이 저장되었습니다.'); }
    };
  }

  function renderMe() {
    if (!state.me) return;
    $('#meAvatar').textContent = state.me.avatar;
    $('#meName').textContent = state.me.name;
    $('#navAvatar').textContent = state.me.avatar;
    $('#tabAvatar').textContent = state.me.avatar;
  }

  /* ---------------- 방 만들기 / 참가 ---------------- */
  function showCreate() {
    const box = openModal(`
      <div class="modal-head">새 게임 방 만들기${closeBtn}</div>
      <div class="modal-body">
        <form id="createForm">
          <div class="field"><label class="lbl">방 이름</label>
            <input class="input" id="crName" maxlength="30" placeholder="${esc((state.me?.name || '나') + '님의 식스틴')}" /></div>
          <div class="field" style="display:flex;gap:12px">
            <div style="flex:1"><label class="lbl">최대 인원</label>
              <select class="input" id="crMax"><option>2</option><option>3</option><option selected>4</option><option>5</option></select></div>
            <div style="flex:1"><label class="lbl">라운드 수</label>
              <select class="input" id="crRounds"><option>1</option><option>2</option><option selected>3</option><option>5</option><option>7</option><option>10</option></select></div>
          </div>
          <div class="modal-actions"><button class="btn" type="button" data-close>취소</button><button class="btn primary" type="submit">만들기</button></div>
        </form>
      </div>`);
    $('#createForm', box).onsubmit = async (e) => {
      e.preventDefault();
      const res = await emit('create', {
        profile: state.me,
        name: $('#crName', box).value,
        maxPlayers: $('#crMax', box).value,
        rounds: $('#crRounds', box).value,
      });
      if (res.ok) { closeModal(); go('game'); }
    };
  }

  function showJoin() {
    const box = openModal(`
      <div class="modal-head">초대 코드로 참가${closeBtn}</div>
      <div class="modal-body">
        <form id="joinForm">
          <input class="input" id="joinCode" placeholder="예: 3FA9C1" maxlength="6" style="text-transform:uppercase;letter-spacing:3px;text-align:center;font-size:20px" required />
          <div class="modal-actions"><button class="btn" type="button" data-close>취소</button><button class="btn primary" type="submit">참가</button></div>
        </form>
      </div>`);
    $('#joinForm', box).onsubmit = async (e) => {
      e.preventDefault();
      const res = await emit('join', { code: $('#joinCode', box).value, profile: state.me });
      if (res.ok) { closeModal(); go('game'); }
    };
  }

  async function joinRoom(code) {
    const res = await emit('join', { code, profile: state.me });
    if (res.ok) go('game');
  }

  async function quickPlay() {
    const res = await emit('create', { profile: state.me, name: `${state.me?.name || ''}의 연습 게임`, maxPlayers: 4, rounds: 3 });
    if (!res.ok) return;
    await emit('addBot');
    await emit('addBot');
    await emit('addBot');
    await emit('start');
    go('game');
  }

  /* ---------------- 규칙 ---------------- */
  const tileHTML = (t, cls = '') =>
    `<div class="tile ${t.n === 0 ? 'joker' : t.c} ${cls}" data-id="${t.id ?? ''}">${t.n === 0 ? '' : t.n}</div>`;
  const T = (n, c) => ({ n, c });

  function showRules(back) {
    const box = openModal(`
      <div class="modal-head">식스틴 게임 규칙${closeBtn}</div>
      <div class="modal-body rules">
        <h4>🎯 목표</h4>
        <p>손에 든 타일을 가장 먼저 모두 내려놓으세요. 라운드가 끝나면 남은 타일 숫자의 합이 벌점이 되고, 모든 라운드 후 <b>벌점이 가장 적은 사람</b>이 우승합니다.</p>
        <h4>🧩 구성물 (88개)</h4>
        <div class="example">${['red', 'yellow', 'green', 'blue', 'purple'].map((c) => tileHTML(T(16, c), 'sm')).join('')}${tileHTML(T(0, 'joker'), 'sm')}</div>
        <ul><li>빨강·노랑·초록·파랑·보라 5가지 색 × 숫자 1~16 = 80개</li><li>조커 8개 — 어떤 숫자로도 사용 가능 (남으면 벌점 20점)</li></ul>
        <h4>🃏 준비</h4>
        <p>2~3인은 16개, 4~5인은 14개씩 받습니다. 타일은 가림막 뒤에서 자동으로 오름차순 정렬되며 다른 사람은 개수만 볼 수 있습니다. 나머지는 뽑기 더미가 됩니다.</p>
        <h4>▶️ 진행</h4>
        <p>선 플레이어가 아래 조합 중 하나를 내려놓고, 시계 방향으로 돌아갑니다.</p>
        <ul>
          <li><b>싱글</b> — 타일 1개</li>
          <li><b>세트</b> — 같은 숫자 2개 이상 (색 무관)</li>
          <li><b>런</b> — 연속된 숫자 3개 이상 (색 무관)</li>
        </ul>
        <p>다음 사람은 <b>같은 형태·같은 개수</b>이면서 <b>더 높은 숫자</b>의 조합으로 덮어야 합니다. (세트는 숫자, 런은 가장 높은 숫자로 비교)</p>
        <div class="example">${tileHTML(T(5, 'red'), 'sm')}${tileHTML(T(6, 'blue'), 'sm')}${tileHTML(T(7, 'green'), 'sm')}<span class="vs">→</span>${tileHTML(T(8, 'yellow'), 'sm')}${tileHTML(T(9, 'purple'), 'sm')}${tileHTML(T(0, 'joker'), 'sm')}</div>
        <p>낼 수 없거나 내고 싶지 않으면 <b>패스</b>하고 더미에서 타일 1개를 가져옵니다. 나머지 모두가 연속으로 패스하면 마지막으로 낸 사람이 테이블을 정리하고 새로 선이 됩니다.</p>
        <h4>🏁 라운드 종료</h4>
        <p>누군가 손패를 모두 내려놓으면 라운드가 끝납니다. 나머지 플레이어는 남은 숫자의 합을 벌점으로 받습니다.</p>
        <p class="note">※ 이 사이트는 식스틴의 핵심 구성(5색 × 1~16 타일, 연속 숫자 내려놓기, 타일을 빨리 털어내 숫자 합을 최소화)을 바탕으로 온라인 플레이에 맞게 정리한 규칙입니다. 세부 규칙은 공식 룰북과 다를 수 있습니다.</p>
        <div class="modal-actions"><button class="btn primary" id="rulesOk">확인</button></div>
      </div>`, { wide: true, dismissable: !back });
    const done = () => (back ? back() : closeModal());
    $('#rulesOk', box).onclick = done;
    $('[data-close]', box).onclick = done;
  }

  /* ---------------- 네비게이션 ---------------- */
  function go(view) {
    if (view === 'create') return showCreate();
    if (view === 'search') return showJoin();
    if (view === 'rules') return showRules();
    if (view === 'profile') return showProfile();
    if (view === 'game' && !state.room) view = 'home';
    state.view = view;
    $('#viewLobby').hidden = view !== 'home';
    $('#viewRoom').hidden = view !== 'game';
    $$('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
    if (view === 'game') renderRoom();
    window.scrollTo(0, 0);
  }
  $$('[data-nav]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); go(b.dataset.nav); }));
  $$('[data-quick]').forEach((b) => (b.onclick = quickPlay));
  $$('.seg').forEach((b) => (b.onclick = () => {
    state.filter = b.dataset.filter;
    $$('.seg').forEach((x) => x.classList.toggle('active', x === b));
    renderLobby();
  }));

  /* ---------------- 로비 렌더링 ---------------- */
  function timeAgo(t) {
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return '방금 전';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    return `${Math.floor(s / 3600)}시간 전`;
  }

  function renderLobby() {
    const { rooms, online } = state.lobby;
    const me = state.me?.name;
    const stories = [
      state.me ? { name: '내 프로필', avatar: state.me.avatar, self: true } : null,
      ...online.filter((u) => u.name !== me),
    ].filter(Boolean);
    $('#stories').innerHTML = stories.length > 1 || state.me
      ? stories.map((u) => `
        <button class="story" ${u.self ? 'data-nav-profile' : ''} title="${esc(u.name)}">
          <span class="avatar ring ${u.inRoom ? 'seen' : ''}">${esc(u.avatar)}</span>
          <span class="name">${esc(u.name)}</span>
        </button>`).join('') +
        (stories.length <= 1 ? '<div class="story-empty">아직 다른 접속자가 없어요. 친구를 초대해 보세요!</div>' : '')
      : '';
    const pf = $('[data-nav-profile]');
    if (pf) pf.onclick = showProfile;

    const list = rooms.filter((r) => state.filter === 'all' || r.status === state.filter);
    const feed = $('#roomFeed');
    if (!list.length) {
      feed.innerHTML = `
        <div class="card empty-feed">
          <div class="big">🎲</div>
          <h3>${state.filter === 'all' ? '열린 방이 없습니다' : '해당하는 방이 없습니다'}</h3>
          <p class="muted">새 방을 만들어 친구를 초대하거나 봇과 연습해 보세요.</p>
          <button class="btn primary" id="emptyCreate">방 만들기</button>
        </div>`;
      $('#emptyCreate').onclick = showCreate;
      return;
    }
    const fanColors = ['red', 'yellow', 'green', 'blue', 'purple'];
    feed.innerHTML = list.map((r) => {
      const seed = [...r.code].reduce((a, c) => a + c.charCodeAt(0), 0);
      const fan = Array.from({ length: 5 }, (_, i) => {
        const n = ((seed * (i + 3)) % 16) + 1;
        const rot = (i - 2) * 9;
        return `<div style="transform:rotate(${rot}deg) translateY(${Math.abs(i - 2) * 6}px)">${tileHTML(T(n, fanColors[(seed + i) % 5]), 'lg')}</div>`;
      }).join('');
      const full = r.members.length >= r.maxPlayers;
      const canJoin = r.status !== 'playing' && !full;
      const statusChip = r.status === 'playing' ? '<span class="chip live">● LIVE</span>'
        : r.status === 'finished' ? '<span class="chip">종료</span>'
          : `<span class="chip">대기 중 ${r.members.length}/${r.maxPlayers}</span>`;
      return `
        <article class="card post">
          <header class="post-head">
            <span class="avatar ring">${esc(r.hostAvatar)}</span>
            <div class="who"><strong>${esc(r.host)}</strong><span class="muted">${esc(r.name)} · ${timeAgo(r.createdAt)}</span></div>
          </header>
          <div class="post-visual">
            <div class="fan">${fan}</div>
            <div class="status">${statusChip}</div>
            <span class="code-tag">#${esc(r.code)}</span>
          </div>
          <div class="post-actions">
            <button class="btn ${canJoin ? 'primary' : ''} sm" data-join="${esc(r.code)}" ${canJoin ? '' : 'disabled'}>${canJoin ? '참가하기' : (full ? '정원 마감' : '진행 중')}</button>
            <button class="icon-btn" data-share="${esc(r.code)}" aria-label="초대 링크 복사"><svg viewBox="0 0 24 24"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg></button>
            <span class="spacer"></span>
            <span class="muted">${r.rounds}라운드</span>
          </div>
          <div class="post-body">
            <div class="members"><div class="stack">${r.members.map((m) => `<span class="avatar ${m.isBot ? 'bot' : ''}">${esc(m.avatar)}</span>`).join('')}</div>
            <span><b>${esc(r.members.map((m) => m.name).join(', '))}</b></span></div>
          </div>
        </article>`;
    }).join('');
    $$('[data-join]', feed).forEach((b) => (b.onclick = () => joinRoom(b.dataset.join)));
    $$('[data-share]', feed).forEach((b) => (b.onclick = () => copyInvite(b.dataset.share)));
  }

  async function copyInvite(code) {
    const url = `${location.origin}${location.pathname}?room=${code}`;
    try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했습니다 🔗'); }
    catch { toast(`초대 코드: ${code}`); }
  }

  /* ---------------- 방 / 게임 ---------------- */
  function onRoom(room) {
    const prev = state.room;
    state.room = room;
    const g = room.game;

    // 새로 받은 타일 강조
    if (g && g.hand) {
      const ids = new Set(g.hand.map((t) => t.id));
      if (state.prevHandIds && prev?.game?.round === g.round) {
        state.newIds = new Set([...ids].filter((id) => !state.prevHandIds.has(id)));
      } else state.newIds = new Set();
      state.prevHandIds = ids;
      for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
    } else {
      state.prevHandIds = null;
      state.selected.clear();
    }

    $('#navGame').hidden = false;
    $('#tabGame').hidden = false;
    if (state.view !== 'game') go('game');
    else renderRoom();

    // 라운드/게임 결과
    if (g && (g.phase === 'roundEnd' || g.phase === 'finished')) {
      const key = `${g.round}-${g.phase}`;
      if (state.shownRoundResult !== key) {
        state.shownRoundResult = key;
        setTimeout(() => showRoundResult(), 500);
      }
    }
    if (g && g.phase === 'playing' && prev?.game && prev.game.current !== g.current && g.current === mySeat()) {
      if (document.hidden) document.title = '🔔 내 차례! · Sixteen';
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Sixteen · 온라인 식스틴'; });

  function mySeat() {
    const r = state.room;
    return r?.game ? r.game.players.findIndex((p) => p.id === r.you) : -1;
  }

  function renderRoom() {
    const r = state.room;
    if (!r) return;
    $('#roomName').textContent = r.name;
    $('#roomCode').textContent = r.code;
    $('#roomMeta').textContent = `${r.members.length}/${r.maxPlayers}명 · ${r.rounds}라운드 · 방장 ${r.host}`;
    const g = r.game;
    $('#waiting').hidden = !!g;
    $('#board').hidden = !g;
    if (!g) renderWaiting(); else renderBoard();
    renderChat();
  }

  function renderWaiting() {
    const r = state.room;
    const colors = ['red', 'yellow', 'green', 'blue', 'purple'];
    $('.tile-deco').innerHTML = [1, 6, 16, 6, 1].map((n, i) => tileHTML(T(n, colors[i]), 'md')).join('');
    const slots = [];
    for (const m of r.memberList) {
      slots.push(`
        <li class="member">
          ${r.isHost && m.id !== r.you ? `<button class="kick" data-kick="${m.id}" aria-label="내보내기"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>` : ''}
          <span class="avatar ring ${m.isBot ? 'bot seen' : ''}">${esc(m.avatar)}<span class="online-dot ${m.online ? '' : 'off'}"></span></span>
          <span class="name">${esc(m.name)}${m.id === r.you ? ' (나)' : ''}</span>
          <span class="tag">${m.isHost ? '👑 방장' : m.isBot ? 'AI 플레이어' : '준비 완료'}</span>
        </li>`);
    }
    for (let i = r.memberList.length; i < r.maxPlayers; i++) {
      slots.push('<li class="member empty"><span class="avatar">+</span><span class="tag">빈 자리</span></li>');
    }
    $('#memberGrid').innerHTML = slots.join('');
    $$('[data-kick]').forEach((b) => (b.onclick = () => emit('kick', { id: b.dataset.kick })));

    $('#hostControls').hidden = !r.isHost;
    $('#setMax').value = String(r.maxPlayers);
    $('#setRounds').value = String(r.rounds);
    $('#addBot').disabled = r.members.length >= r.maxPlayers;
    $('#startGame').disabled = r.members.length < 2;
    $('#waitHint').textContent = r.isHost
      ? (r.members.length < 2 ? '최소 2명이 필요합니다. 봇을 추가해 보세요!' : '')
      : '방장이 게임을 시작하기를 기다리는 중...';
  }

  $('#setMax').onchange = (e) => emit('settings', { maxPlayers: e.target.value });
  $('#setRounds').onchange = (e) => emit('settings', { rounds: e.target.value });
  $('#addBot').onclick = () => emit('addBot');
  $('#startGame').onclick = () => emit('start');
  $('#copyCode').onclick = () => copyInvite(state.room.code);
  $('#leaveRoom').onclick = async () => {
    const g = state.room?.game;
    if (g && g.phase === 'playing' && !confirm('게임을 떠나면 봇이 대신 플레이합니다. 나가시겠습니까?')) return;
    await emit('leave');
    state.room = null;
    state.shownRoundResult = null;
    $('#navGame').hidden = true;
    $('#tabGame').hidden = true;
    closeChat();
    go('home');
  };

  function memberAvatar(id) {
    const m = state.room.memberList.find((x) => x.id === id);
    return m ? m.avatar : '🙂';
  }

  function renderBoard() {
    const r = state.room;
    const g = r.game;
    const me = mySeat();
    const myTurn = g.phase === 'playing' && g.current === me;
    $('#board').classList.toggle('not-turn', !myTurn);

    // 상대 (스토리 스타일)
    const order = g.players.map((p, i) => ({ ...p, seat: i }));
    const rotated = me >= 0 ? [...order.slice(me + 1), ...order.slice(0, me)] : order;
    $('#opponents').innerHTML = rotated.map((p) => {
      const turn = g.phase === 'playing' && g.current === p.seat;
      const backs = Array.from({ length: Math.min(p.count, 8) }, () => '<div class="tile back"></div>').join('');
      const member = r.memberList.find((m) => m.id === p.id);
      const online = !member || member.online;
      const stalled = turn && !p.isBot && g.lastMoveAt && Date.now() - g.lastMoveAt > STALL_MS;
      return `
        <div class="opp ${turn ? 'turn' : ''}">
          <span class="avatar ring ${p.isBot ? 'bot' : ''}">${esc(memberAvatar(p.id))}<span class="online-dot ${online ? '' : 'off'}"></span></span>
          <div class="meta"><strong>${esc(p.name)}</strong><span>${p.count}개 · 벌점 ${p.score}</span></div>
          ${stalled ? `<button class="btn sm" data-replace="${esc(p.id)}" title="응답이 없는 플레이어를 봇으로 대체">🤖 봇으로 대체</button>` : `<div class="mini-backs">${backs}</div>`}
        </div>`;
    }).join('');
    $$('[data-replace]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      if ((await emit('replace', { id: b.dataset.replace })).ok) toast('봇이 대신 플레이합니다');
      b.disabled = false;
    }));

    $('#roundChip').textContent = `라운드 ${g.round}/${g.maxRounds}`;
    $('#pileChip').textContent = `🂠 더미 ${g.drawPile}`;
    $('#comboChip').textContent = g.table ? `현재: ${g.table.label}` : '선: 자유롭게 내세요';

    if (g.table) {
      const by = g.players[g.table.by];
      $('#tableBy').innerHTML = `<span class="avatar">${esc(memberAvatar(by.id))}</span> ${esc(by.name)}님이 냈습니다`;
      $('#tableTiles').innerHTML = g.table.tiles.map((t) => tileHTML(t, 'lg')).join('');
    } else {
      $('#tableBy').innerHTML = '';
      $('#tableTiles').innerHTML = '<div class="placeholder">테이블이 비어 있습니다<br><small>싱글 · 세트 · 런 무엇이든 낼 수 있어요</small></div>';
    }
    const cur = g.players[g.current];
    const banner = $('#turnBanner');
    if (g.phase !== 'playing') {
      banner.className = 'turn-banner';
      banner.textContent = g.phase === 'finished' ? '🏆 게임 종료' : '라운드 종료';
    } else if (myTurn) {
      banner.className = 'turn-banner mine';
      banner.textContent = g.table ? '내 차례! 더 높은 조합을 내거나 패스하세요' : '내 차례! 선입니다';
    } else {
      banner.className = 'turn-banner';
      banner.textContent = `${cur.name}님의 차례${cur.isBot ? ' 🤖 생각 중…' : '…'}`;
    }

    // 내 손패
    const mine = g.players[me];
    $('#handAvatar').textContent = state.me?.avatar || '🙂';
    $('#handName').textContent = mine ? mine.name : '관전 중';
    $('#handInfo').textContent = mine ? `타일 ${mine.count}개 · 누적 벌점 ${mine.score}` : '';
    const hand = g.hand || [];
    $('#hand').innerHTML = hand.map((t) =>
      tileHTML(t, `${state.selected.has(t.id) ? 'sel' : ''} ${state.newIds.has(t.id) ? 'new' : ''}`)).join('');
    $$('#hand .tile').forEach((el) => (el.onclick = () => toggleTile(Number(el.dataset.id))));
    $('#passBtn').disabled = !myTurn || !g.table;
    $('#passBtn').textContent = g.drawPile ? '패스 · 1장 뽑기' : '패스';
    updateSelection();
  }

  function toggleTile(id) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    const el = $(`#hand .tile[data-id="${id}"]`);
    if (el) el.classList.toggle('sel', state.selected.has(id));
    updateSelection();
  }

  function updateSelection() {
    const g = state.room?.game;
    const info = $('#selectionInfo');
    const hand = g?.hand || [];
    const tiles = hand.filter((t) => state.selected.has(t.id));
    const myTurn = g && g.phase === 'playing' && g.current === mySeat();
    info.className = 'selection-info';
    if (!tiles.length) {
      info.textContent = myTurn ? '낼 타일을 선택하세요' : '타일을 미리 골라둘 수 있어요';
      $('#playBtn').disabled = true;
      return;
    }
    const table = g.table ? g.table.combo : null;
    const combo = Sixteen.chooseInterpretation(tiles, table);
    if (combo) {
      info.textContent = `✓ ${Sixteen.describeCombo(combo)}`;
      info.classList.add('ok');
    } else {
      const any = Sixteen.interpret(tiles)[0];
      info.textContent = any ? `✕ ${Sixteen.describeCombo(any)} — 테이블보다 높아야 해요` : '✕ 올바른 조합이 아니에요';
      info.classList.add('bad');
    }
    $('#playBtn').disabled = !combo || !myTurn;
  }

  $('#clearSel').onclick = () => { state.selected.clear(); renderBoard(); };
  $('#playBtn').onclick = async () => {
    const ids = [...state.selected];
    const res = await emit('play', { tileIds: ids });
    if (res.ok) state.selected.clear();
  };
  $('#passBtn').onclick = async () => {
    const res = await emit('pass');
    if (res.ok && res.drew) toast('타일 1개를 가져왔습니다');
  };

  function showRoundResult() {
    const g = state.room?.game;
    if (!g || !g.lastRound) return;
    const final = g.phase === 'finished';
    const lr = g.lastRound;
    const rows = final
      ? g.standings.map((s, i) => `
          <li class="result-row ${i === 0 ? 'winner' : ''}">
            <span class="rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span>
            <span class="avatar">${esc(memberAvatar(s.id))}</span>
            <div class="info"><strong>${esc(s.name)}</strong></div>
            <span class="pts">${s.score}점</span>
          </li>`).join('')
      : lr.results.map((res, i) => `
          <li class="result-row ${i === lr.winner ? 'winner' : ''}">
            <span class="rank">${i === lr.winner ? '👑' : ''}</span>
            <span class="avatar">${esc(memberAvatar(res.id))}</span>
            <div class="info"><strong>${esc(res.name)}</strong>
              <div class="rem">${res.remaining.slice(0, 16).map((t) => tileHTML(t, 'sm')).join('')}</div></div>
            <span class="pts">+${res.penalty}</span>
          </li>`).join('');
    const winnerName = final ? g.standings[0].name : lr.results[lr.winner].name;
    const box = openModal(`
      <div class="modal-head">${final ? '최종 결과' : `라운드 ${g.round} 결과`}${closeBtn}</div>
      <div class="modal-body">
        <div class="trophy">${final ? '🏆' : '🎉'}</div>
        <p class="center"><b>${esc(winnerName)}</b>님이 ${final ? '최종 우승했습니다!' : '라운드에서 이겼습니다!'}</p>
        <ul class="result-list">${rows}</ul>
        <div class="modal-actions">
          ${state.room.isHost
            ? (final ? '<button class="btn gradient" id="resAgain">대기실로 · 다시 하기</button>' : '<button class="btn primary" id="resNext">다음 라운드 시작</button>')
            : `<button class="btn" data-close>${final ? '닫기' : '방장이 다음 라운드를 시작합니다'}</button>`}
        </div>
      </div>`, { wide: true });
    const next = $('#resNext', box);
    if (next) next.onclick = async () => { if ((await emit('next')).ok) closeModal(); };
    const again = $('#resAgain', box);
    if (again) again.onclick = async () => { if ((await emit('reset')).ok) { closeModal(); state.shownRoundResult = null; } };
  }

  /* ---------------- 채팅 ---------------- */
  function renderChat() {
    const r = state.room;
    const body = $('#chatBody');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.innerHTML = r.chat.map((m) => {
      if (m.system) return `<div class="sys">${esc(m.text)}</div>`;
      const mine = m.from.id === r.you;
      return `
        <div class="msg ${mine ? 'mine' : ''}">
          <span class="avatar">${esc(m.from.avatar)}</span>
          <div><div class="who">${esc(m.from.name)}</div><div class="bubble">${esc(m.text)}</div></div>
        </div>`;
    }).join('') || '<div class="sys">첫 메시지를 보내보세요 👋</div>';
    if (atBottom || !state.chatRendered) body.scrollTop = body.scrollHeight;
    state.chatRendered = true;
    $('#chatCount').textContent = `${r.memberList.filter((m) => !m.isBot).length}명 참여 중`;

    const g = r.game;
    const log = $('#logBody');
    log.innerHTML = g ? g.log.slice().reverse().map((l) => `<div class="log-item">${esc(l.text)}</div>`).join('') : '<div class="sys">게임이 시작되면 기록이 표시됩니다</div>';

    if (g) {
      const rounds = Array.from({ length: g.maxRounds }, (_, i) => i + 1);
      const lead = Math.min(...g.players.map((p) => p.score));
      $('#scoreBody').innerHTML = `
        <table class="score-table">
          <thead><tr><th>플레이어</th>${rounds.map((n) => `<th>R${n}</th>`).join('')}<th>합계</th></tr></thead>
          <tbody>${g.players.map((p) => `<tr class="${p.score === lead ? 'lead' : ''}"><td>${esc(memberAvatar(p.id))} ${esc(p.name)}</td>${rounds.map((_, i) => `<td>${p.roundScores[i] ?? '–'}</td>`).join('')}<td>${p.score}</td></tr>`).join('')}</tbody>
        </table><p class="muted center" style="margin-top:12px">벌점이 적을수록 좋아요</p>`;
    } else $('#scoreBody').innerHTML = '<div class="sys">아직 점수가 없습니다</div>';

    const userMsgs = r.chat.filter((m) => !m.system).length;
    if (state.chatOpen || window.innerWidth > 1100) state.lastChatSeen = userMsgs;
    const unread = userMsgs - state.lastChatSeen;
    $('#chatBadge').hidden = unread <= 0;
    $('#chatBadge').textContent = unread > 9 ? '9+' : unread;
  }

  $$('.tab').forEach((b) => (b.onclick = () => {
    state.tab = b.dataset.tab;
    $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
    $('#chatBody').hidden = state.tab !== 'chat';
    $('#logBody').hidden = state.tab !== 'log';
    $('#scoreBody').hidden = state.tab !== 'score';
    $('#chatForm').hidden = state.tab !== 'chat';
  }));

  $('#chatForm').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await emit('chat', { text });
  };
  function openChat() {
    state.chatOpen = true;
    $('#chatPanel').classList.add('open');
    if (state.room) renderChat();
  }
  function closeChat() { state.chatOpen = false; $('#chatPanel').classList.remove('open'); }
  $('#chatFab').onclick = openChat;
  $('#chatClose').onclick = closeChat;

  // 키보드 단축키: Enter = 내려놓기, P = 패스
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'game' || !state.room?.game || !$('#modal').hidden) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.key === 'Enter' && !$('#playBtn').disabled) $('#playBtn').click();
    if ((e.key === 'p' || e.key === 'P') && !$('#passBtn').disabled) $('#passBtn').click();
    if (e.key === 'Escape') { state.selected.clear(); renderBoard(); }
  });

  setInterval(() => { if (state.view === 'home') renderLobby(); }, 30000);
  // 응답 없는 플레이어 감지(봇 대체 버튼)를 위해 게임 화면을 주기적으로 갱신
  setInterval(() => {
    const g = state.room?.game;
    if (state.view === 'game' && g?.phase === 'playing' && g.lastMoveAt && Date.now() - g.lastMoveAt > STALL_MS - 5000) renderBoard();
  }, 5000);

  boot();
}
