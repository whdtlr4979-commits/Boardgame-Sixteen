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
          <div class="field"><label class="lbl">최대 인원</label>
            <select class="input" id="crMax"><option>2</option><option>3</option><option selected>4</option></select></div>
          <div class="modal-actions"><button class="btn" type="button" data-close>취소</button><button class="btn primary" type="submit">만들기</button></div>
        </form>
      </div>`);
    $('#createForm', box).onsubmit = async (e) => {
      e.preventDefault();
      const res = await emit('create', {
        profile: state.me,
        name: $('#crName', box).value,
        maxPlayers: $('#crMax', box).value,
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
    const res = await emit('create', { profile: state.me, name: `${state.me?.name || ''}의 연습 게임`, maxPlayers: 4 });
    if (!res.ok) return;
    await emit('addBot');
    await emit('addBot');
    await emit('addBot');
    await emit('start');
    go('game');
  }

  /* ---------------- 규칙 ---------------- */
  // 타일 그림은 public/tiles/ 의 이미지 파일을 사용한다 (파일을 고치면 게임에 바로 반영).
  // PNG 등 다른 형식으로 바꾸려면 파일을 같은 이름으로 저장하고 TILE_EXT 만 바꾸면 된다.
  const TILE_DIR = 'tiles/';
  const TILE_EXT = 'svg';
  function tileFile(t) {
    const k = t.k || 'num';
    const name = k === 'scissors' || k === 'trash' ? k : k === 'num' ? `${t.c}-${t.n}` : `${t.c}-${k}`;
    return `${TILE_DIR}${name}.${TILE_EXT}`;
  }
  const tileHTML = (t, cls = '') => {
    const k = t.k || 'num';
    const label = esc(Sixteen.describeTile({ k, ...t }));
    return `<div class="tile ${t.c || 'none'} k-${k} ${cls}" data-id="${t.id ?? ''}" title="${label}"><img src="${tileFile(t)}" alt="${label}" draggable="false"></div>`;
  };
  const backHTML = () => `<div class="tile back"><img src="${TILE_DIR}back.${TILE_EXT}" alt="" draggable="false"></div>`;
  const T = (n, c, k = 'num') => ({ n, c, k });

  function showRules(back) {
    const box = openModal(`
      <div class="modal-head">식스틴 게임 규칙${closeBtn}</div>
      <div class="modal-body rules">
        <h4>🎯 목표</h4>
        <p>가림막 뒤의 타일을 <b>가장 먼저 모두 내면</b> 즉시 승리합니다. 모두 더 이상 낼 수 없으면 <b>남은 타일 숫자의 합이 가장 적은 사람</b>이 이깁니다.</p>
        <h4>🧩 구성물 (88개)</h4>
        <div class="example">${['red', 'orange', 'green', 'blue', 'black'].map((c, i) => tileHTML(T([1, 10, 7, 3, 12][i], c), 'sm')).join('')}
          ${tileHTML(T(16, 'blue', 'restart'), 'sm')}${tileHTML(T(16, 'green', 'end'), 'sm')}${tileHTML(T(0, null, 'scissors'), 'sm')}${tileHTML(T(0, null, 'trash'), 'sm')}</div>
        <ul>
          <li>숫자 타일 85개: 빨강·주황·초록·파랑·검정 5색 × (1~15 + <b>16 RESTART</b> + <b>16 END</b>)</li>
          <li>기능 타일 3개: <b>가위</b> 2개, <b>쓰레기통</b> 1개</li>
        </ul>
        <h4>🃏 게임 준비</h4>
        <ul>
          <li>4인 22개, 3인 29개, 2인 30개씩 나눠 받습니다 (남은 타일은 사용하지 않음). 타일은 가림막 뒤에서 색깔별로 정리됩니다.</li>
          <li>2인은 숫자 1 타일 5개를 먼저 꺼내 놓고 나눕니다.</li>
          <li>각자 가진 숫자 1 타일을 모두 테이블에 내고, <b>빨강 1을 낸 사람</b>부터 시계 방향으로 진행합니다. (2인은 무작위로 선을 정합니다)</li>
        </ul>
        <h4>▶️ 게임 진행</h4>
        <p>자기 차례에 한 가지 색을 골라, 그 색의 <b>가장 마지막 타일보다 큰</b> 숫자 타일 1개 또는 <b>연속된 숫자 그룹</b>(2개 이상)을 냅니다. 숫자를 건너뛸 수 있습니다.</p>
        <div class="example">${tileHTML(T(1, 'blue'), 'sm')}<span class="vs">‹</span>${tileHTML(T(7, 'blue'), 'sm')}<span class="vs">‹</span>${tileHTML(T(10, 'blue'), 'sm')}<span class="vs">…</span>${tileHTML(T(5, 'blue'), 'sm')}<span class="vs">✕</span>
          <span class="vs">그룹</span>${tileHTML(T(10, 'green'), 'sm')}${tileHTML(T(11, 'green'), 'sm')}${tileHTML(T(12, 'green'), 'sm')}</div>
        <h4>✨ 기능 타일</h4>
        <ul>
          <li>${tileHTML(T(16, 'blue', 'restart'), 'sm inline')} <b>16 RESTART</b> — 놓으면 1로 바뀌어, 그 색을 다시 1보다 큰 숫자부터 놓을 수 있습니다.</li>
          <li>${tileHTML(T(16, 'red', 'end'), 'sm inline')} <b>16 END</b> — 그 색에는 더 이상 놓을 수 없습니다. 가위·쓰레기통으로 END를 제거하면 다시 놓을 수 있습니다. 한 번에 RESTART와 END를 함께 놓을 수는 없습니다.</li>
          <li>${tileHTML(T(0, null, 'scissors'), 'sm inline')} <b>가위</b> — 한 가지 색의 가장 마지막 타일 1개를 제거하고, 숫자 타일을 <b>한 번 더</b> 놓을 수 있습니다.</li>
          <li>${tileHTML(T(0, null, 'trash'), 'sm inline')} <b>쓰레기통</b> — 한 가지 색에서 원하는 만큼(1 타일 제외) 제거하고, 숫자 타일을 <b>한 번 더</b> 놓을 수 있습니다.</li>
        </ul>
        <h4>⏭️ 패스와 종료</h4>
        <p>낼 수 있는 타일이 없을 때만 패스합니다. 한 사람이 타일을 모두 내면 즉시 끝나고, 모두 더 이상 낼 수 없어도 끝납니다.</p>
        <p><b>점수</b>: 남은 타일에 적힌 숫자의 합 (16 타일은 16). 기능 타일은 반드시 사용해야 하며, 남아 있으면 <b>각각 20점</b>으로 계산합니다.</p>
        <p class="note">※ 매직빈게임즈 식스틴 공식 룰을 바탕으로 구현했습니다. 2인 선 정하기(가위바위보)는 무작위로 대신합니다.</p>
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
    const fanColors = ['red', 'orange', 'green', 'blue', 'black'];
    feed.innerHTML = list.map((r) => {
      const seed = [...r.code].reduce((a, c) => a + c.charCodeAt(0), 0);
      const fan = Array.from({ length: 5 }, (_, i) => {
        const n = ((seed * (i + 3)) % 15) + 1;
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
            <span class="muted">최대 ${r.maxPlayers}인</span>
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
      if (state.prevHandIds && prev?.game?.phase === 'playing' && g.phase === 'playing') {
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

    // 게임 결과
    if (g && g.phase === 'finished') {
      const key = `fin-${g.lastMoveAt}`;
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
    $('#roomMeta').textContent = `${r.members.length}/${r.maxPlayers}명 · 방장 ${r.host}`;
    const g = r.game;
    $('#waiting').hidden = !!g;
    $('#board').hidden = !g;
    if (!g) renderWaiting(); else renderBoard();
    renderChat();
  }

  function renderWaiting() {
    const r = state.room;
    const colors = ['red', 'orange', 'green', 'blue', 'black'];
    $('.tile-deco').innerHTML = [1, 6, 16, 6, 1].map((n, i) => tileHTML(T(n, colors[i], n === 16 ? 'end' : 'num'), 'md')).join('');
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
    $('#addBot').disabled = r.members.length >= r.maxPlayers;
    $('#startGame').disabled = r.members.length < 2;
    $('#waitHint').textContent = r.isHost
      ? (r.members.length < 2 ? '최소 2명이 필요합니다. 봇을 추가해 보세요!' : '')
      : '방장이 게임을 시작하기를 기다리는 중...';
  }

  $('#setMax').onchange = (e) => emit('settings', { maxPlayers: e.target.value });
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
      const backs = Array.from({ length: Math.min(p.count, 8) }, backHTML).join('');
      const member = r.memberList.find((m) => m.id === p.id);
      const online = !member || member.online;
      const stalled = turn && !p.isBot && g.lastMoveAt && Date.now() - g.lastMoveAt > STALL_MS;
      return `
        <div class="opp ${turn ? 'turn' : ''}">
          <span class="avatar ring ${p.isBot ? 'bot' : ''}">${esc(memberAvatar(p.id))}<span class="online-dot ${online ? '' : 'off'}"></span></span>
          <div class="meta"><strong>${esc(p.name)}</strong><span>타일 ${p.count}개${g.phase === 'finished' ? ` · ${p.score}점` : ''}</span></div>
          ${stalled ? `<button class="btn sm" data-replace="${esc(p.id)}" title="응답이 없는 플레이어를 봇으로 대체">🤖 봇으로 대체</button>` : `<div class="mini-backs">${backs}</div>`}
        </div>`;
    }).join('');
    $$('[data-replace]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      if ((await emit('replace', { id: b.dataset.replace })).ok) toast('봇이 대신 플레이합니다');
      b.disabled = false;
    }));

    $('#discardChip').textContent = `🗑 버린 타일 ${g.discard}`;
    $('#unusedChip').textContent = `미사용 ${g.unused}`;
    $('#unusedChip').hidden = !g.unused;
    const lastLog = g.log[g.log.length - 1];
    $('#lastChip').textContent = lastLog ? lastLog.text : '';

    $('#rows').innerHTML = g.rows.map((row) => {
      const tiles = row.tiles.length > 10 ? [row.tiles[0], null, ...row.tiles.slice(-8)] : row.tiles;
      const justPlayed = g.lastPlay && g.lastPlay.row === row.color;
      return `
        <div class="row ${row.closed || !row.tiles.length ? 'closed' : ''} ${justPlayed ? 'just' : ''}" data-row="${row.color}">
          <span class="row-label ${row.color}">${Sixteen.COLOR_NAMES[row.color]}</span>
          <div class="row-tiles">${tiles.length ? tiles.map((t) => (t ? tileHTML(t, 'md') : '<span class="row-gap">…</span>')).join('') : '<span class="row-gap">이 색의 1 타일이 상자에 남아 놓을 수 없습니다</span>'}</div>
          <span class="row-top">${!row.tiles.length ? '1 없음' : row.closed ? '■ 닫힘' : `${row.top} 초과`}</span>
        </div>`;
    }).join('');
    $$('#rows .row').forEach((el) => (el.onclick = () => playOnRow(el.dataset.row)));

    const cur = g.players[g.current];
    const hand = g.hand || [];
    const rules = { numbersOnly: g.bonus };
    const canMove = myTurn && Sixteen.hasLegalMove(g.rows, hand, rules);
    const banner = $('#turnBanner');
    if (g.phase !== 'playing') {
      banner.className = 'turn-banner';
      banner.textContent = '🏆 게임 종료';
    } else if (myTurn) {
      banner.className = 'turn-banner mine';
      banner.textContent = g.bonus
        ? (canMove ? '✨ 숫자 타일을 한 번 더 놓을 수 있어요!' : '더 놓을 숫자 타일이 없어요 — 차례를 넘기세요')
        : (canMove ? '내 차례! 같은 색 줄 끝보다 큰 숫자를 놓으세요' : '낼 수 있는 타일이 없어요 — 패스하세요');
    } else {
      banner.className = 'turn-banner';
      banner.textContent = `${cur.name}님의 차례${g.bonus ? ' (한 번 더)' : ''}${cur.isBot ? ' 🤖 생각 중…' : '…'}`;
    }

    // 내 손패
    const mine = g.players[me];
    $('#handAvatar').textContent = state.me?.avatar || '🙂';
    $('#handName').textContent = mine ? mine.name : '관전 중';
    const handSum = hand.reduce((sum, t) => sum + Sixteen.tilePenalty(t), 0);
    $('#handInfo').textContent = mine ? `타일 ${mine.count}개 · 남은 숫자 합 ${handSum}` : '';
    $('#hand').innerHTML = hand.map((t) =>
      tileHTML(t, `${state.selected.has(t.id) ? 'sel' : ''} ${state.newIds.has(t.id) ? 'new' : ''}`)).join('');
    $$('#hand .tile').forEach((el) => (el.onclick = () => toggleTile(Number(el.dataset.id))));
    $('#passBtn').disabled = !myTurn || canMove;
    $('#passBtn').textContent = g.bonus ? '넘기기' : '패스';
    updateSelection();
  }

  function toggleTile(id) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    const el = $(`#hand .tile[data-id="${id}"]`);
    if (el) el.classList.toggle('sel', state.selected.has(id));
    updateSelection();
  }

  /** 현재 선택을 검사: { tiles, v } (v = validatePlay 결과, 줄이 필요한 특수 타일은 needsRow) */
  function currentSelection(rowColor) {
    const g = state.room?.game;
    const hand = g?.hand || [];
    const tiles = hand.filter((t) => state.selected.has(t.id));
    if (!g || !tiles.length) return { tiles, v: null };
    return { tiles, v: Sixteen.validatePlay(g.rows, tiles, rowColor, { numbersOnly: g.bonus }) };
  }

  function updateSelection() {
    const g = state.room?.game;
    const info = $('#selectionInfo');
    const myTurn = g && g.phase === 'playing' && g.current === mySeat();
    const { tiles, v } = currentSelection();
    info.className = 'selection-info';
    $$('#rows .row').forEach((el) => el.classList.remove('target'));
    $('#playBtn').disabled = true;
    if (!tiles.length) {
      info.textContent = myTurn ? '놓을 타일을 선택하세요' : '타일을 미리 골라둘 수 있어요';
      return;
    }
    const special = tiles.length === 1 && Sixteen.isColorless(tiles[0]);
    if (special) {
      const targets = g.rows.filter((r) => Sixteen.validatePlay(g.rows, tiles, r.color, { numbersOnly: g.bonus }).ok);
      targets.forEach((r) => $(`#rows .row[data-row="${r.color}"]`)?.classList.add('target'));
      info.textContent = g.bonus ? '✕ 이번에는 숫자 타일만 놓을 수 있어요'
        : targets.length ? `${Sixteen.describeTile(tiles[0])} — 사용할 줄을 누르세요` : '✕ 사용할 수 있는 줄이 없어요';
      info.classList.add(targets.length ? 'ok' : 'bad');
      return;
    }
    if (v.ok) {
      info.textContent = `✓ ${v.label}`;
      info.classList.add('ok');
      $(`#rows .row[data-row="${v.row}"]`)?.classList.add('target');
      $('#playBtn').disabled = !myTurn;
    } else {
      info.textContent = `✕ ${v.error}`;
      info.classList.add('bad');
    }
  }

  async function play(rowColor, count) {
    const { tiles, v } = currentSelection(rowColor);
    if (!v || !v.ok) {
      if (v) toast(v.error, true);
      return;
    }
    if (v.kind === 'trash' && count == null) return pickTrashCount(v.row, v.max);
    const res = await emit('play', { tileIds: tiles.map((t) => t.id), row: v.row, count });
    if (res.ok) state.selected.clear();
  }

  /** 쓰레기통: 줄 끝에서 몇 개를 제거할지 고른다 (1 타일 제외). */
  function pickTrashCount(rowColor, max) {
    const row = state.room.game.rows.find((r) => r.color === rowColor);
    const box = openModal(`
      <div class="modal-head">🗑 쓰레기통 — ${Sixteen.COLOR_NAMES[rowColor]} 줄${closeBtn}</div>
      <div class="modal-body">
        <p class="center">줄 끝에서 제거할 타일 개수를 고르세요. (1 타일은 남습니다)</p>
        <div class="example trash-pick" id="trashRow" style="justify-content:center">${row.tiles.map((t) => tileHTML(t, 'sm')).join('')}</div>
        <div class="count-btns">${Array.from({ length: max }, (_, i) => `<button class="btn" data-count="${i + 1}">${i + 1}개</button>`).join('')}</div>
      </div>`);
    const tilesEl = $$('#trashRow .tile', box);
    const mark = (n) => tilesEl.forEach((el, i) => el.classList.toggle('gone', i >= tilesEl.length - n));
    $$('[data-count]', box).forEach((b) => {
      b.onmouseenter = () => mark(Number(b.dataset.count));
      b.onfocus = () => mark(Number(b.dataset.count));
      b.onclick = () => { closeModal(); play(rowColor, Number(b.dataset.count)); };
    });
    mark(max);
  }

  function playOnRow(rowColor) {
    const g = state.room?.game;
    if (!g || g.phase !== 'playing' || g.current !== mySeat() || !state.selected.size) return;
    play(rowColor);
  }

  $('#clearSel').onclick = () => { state.selected.clear(); renderBoard(); };
  $('#playBtn').onclick = () => play();
  $('#passBtn').onclick = () => emit('pass');

  function showRoundResult() {
    const g = state.room?.game;
    if (!g || !g.lastRound) return;
    const lr = g.lastRound;
    const order = g.standings.map((s) => lr.results.findIndex((r) => r.id === s.id));
    const rows = order.map((idx, rank) => {
      const res = lr.results[idx];
      return `
          <li class="result-row ${idx === lr.winner ? 'winner' : ''}">
            <span class="rank">${idx === lr.winner ? '👑' : rank + 1}</span>
            <span class="avatar">${esc(memberAvatar(res.id))}</span>
            <div class="info"><strong>${esc(res.name)}</strong>
              <div class="rem">${res.remaining.length ? res.remaining.slice(0, 20).map((t) => tileHTML(t, 'sm')).join('') : '<span class="muted">모두 내려놓음 🎉</span>'}</div></div>
            <span class="pts">${res.penalty}점</span>
          </li>`;
    }).join('');
    const winnerName = lr.results[lr.winner].name;
    const box = openModal(`
      <div class="modal-head">게임 결과${closeBtn}</div>
      <div class="modal-body">
        <div class="trophy">🏆</div>
        <p class="center"><b>${esc(winnerName)}</b>님 승리! ${lr.emptied ? '타일을 모두 내려놓았습니다.' : '아무도 더 놓을 수 없어 남은 숫자 합으로 결정되었습니다.'}</p>
        <ul class="result-list">${rows}</ul>
        <div class="modal-actions">
          ${state.room.isHost
            ? '<button class="btn gradient" id="resAgain">대기실로 · 다시 하기</button>'
            : '<button class="btn" data-close>닫기</button>'}
        </div>
      </div>`, { wide: true });
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
      const done = g.phase === 'finished';
      $('#scoreBody').innerHTML = `
        <table class="score-table">
          <thead><tr><th>플레이어</th><th>남은 타일</th><th>${done ? '벌점' : ''}</th></tr></thead>
          <tbody>${g.players.map((p, i) => `<tr class="${done && g.lastRound.winner === i ? 'lead' : ''}"><td>${esc(memberAvatar(p.id))} ${esc(p.name)}</td><td>${p.count}</td><td>${done ? p.score : ''}</td></tr>`).join('')}</tbody>
        </table><p class="muted center" style="margin-top:12px">먼저 다 내려놓거나, 끝났을 때 남은 숫자 합이 가장 적으면 승리</p>`;
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
