'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { SixteenGame, botMove, MIN_PLAYERS, MAX_PLAYERS } = require('./src/game');

const PORT = process.env.PORT || 3000;
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS || 1100);
const ROOM_IDLE_MS = 1000 * 60 * 30;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/game.js', (_req, res) => res.sendFile(path.join(__dirname, 'src', 'game.js')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server);

/** token -> { token, name, avatar, socketId, roomCode } */
const users = new Map();
/** code -> room */
const rooms = new Map();

const AVATARS = ['🦊', '🐼', '🐯', '🐨', '🐸', '🐙', '🦄', '🐧', '🦁', '🐰', '🐻', '🐳'];
const BOT_NAMES = ['알파봇', '베타봇', '감마봇', '델타봇', '엡실론봇'];

const clean = (s, max = 20) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

function newRoomCode() {
  let code;
  do code = crypto.randomBytes(3).toString('hex').toUpperCase();
  while (rooms.has(code));
  return code;
}

function roomSummary(room) {
  const host = room.members.find((m) => m.token === room.hostToken);
  return {
    code: room.code,
    name: room.name,
    host: host ? host.name : '',
    hostAvatar: host ? host.avatar : '🎲',
    members: room.members.map((m) => ({ name: m.name, avatar: m.avatar, isBot: m.isBot })),
    maxPlayers: room.maxPlayers,
    rounds: room.rounds,
    status: room.game ? (room.game.phase === 'finished' ? 'finished' : 'playing') : 'waiting',
    createdAt: room.createdAt,
  };
}

function broadcastLobby() {
  const online = [...users.values()]
    .filter((u) => u.socketId)
    .map((u) => ({ name: u.name, avatar: u.avatar, inRoom: !!u.roomCode }));
  io.emit('lobby', {
    rooms: [...rooms.values()].map(roomSummary).sort((a, b) => b.createdAt - a.createdAt),
    online,
  });
}

function sendRoom(room) {
  const base = {
    ...roomSummary(room),
    hostToken: undefined,
    chat: room.chat.slice(-80),
  };
  for (const m of room.members) {
    if (m.isBot) continue;
    const u = users.get(m.token);
    if (!u || !u.socketId) continue;
    io.to(u.socketId).emit('room', {
      ...base,
      you: m.id,
      isHost: m.token === room.hostToken,
      memberList: room.members.map((x) => ({
        id: x.id,
        name: x.name,
        avatar: x.avatar,
        isBot: x.isBot,
        isHost: x.token === room.hostToken,
        online: x.isBot || !!(users.get(x.token) || {}).socketId,
      })),
      game: room.game ? room.game.viewFor(m.id) : null,
    });
  }
}

function pushChat(room, from, text, system = false) {
  room.chat.push({ id: crypto.randomUUID(), from, text, system, t: Date.now() });
  if (room.chat.length > 200) room.chat.shift();
  room.touched = Date.now();
}

function scheduleBots(room) {
  clearTimeout(room.botTimer);
  const g = room.game;
  if (!g || g.phase !== 'playing') return;
  const seat = g.players[g.current];
  if (!seat.isBot) return;
  const turnId = g.turnId;
  room.botTimer = setTimeout(() => {
    if (room.game !== g || g.turnId !== turnId || g.phase !== 'playing') return;
    const move = botMove(g, seat.id);
    try {
      if (move.action === 'play') g.play(seat.id, move.tileIds);
      else g.pass(seat.id);
    } catch (e) {
      // 봇 수가 거부되면 안전하게 패스(선이면 가장 낮은 타일)로 처리한다.
      const p = g.players[g.current];
      if (g.table) g.pass(p.id);
      else g.play(p.id, [p.hand[0].id]);
    }
    afterGameChange(room);
  }, BOT_DELAY_MS);
}

function afterGameChange(room) {
  room.touched = Date.now();
  sendRoom(room);
  broadcastLobby();
  scheduleBots(room);
}

function leaveRoom(user, { silent = false } = {}) {
  const room = rooms.get(user.roomCode);
  user.roomCode = null;
  if (!room) return;
  const idx = room.members.findIndex((m) => m.token === user.token);
  if (idx < 0) return;
  const member = room.members[idx];

  if (room.game && room.game.phase !== 'finished') {
    // 진행 중이면 자리를 봇으로 대체해 게임이 멈추지 않게 한다.
    member.isBot = true;
    member.replaced = true;
    member.token = `bot:${member.id}`;
    member.name = `${member.name}(봇)`;
    const gp = room.game.players.find((p) => p.id === member.id);
    if (gp) {
      gp.isBot = true;
      gp.name = member.name;
    }
  } else {
    room.members.splice(idx, 1);
  }
  if (!silent) pushChat(room, null, `${user.name}님이 나갔습니다.`, true);

  const humans = room.members.filter((m) => !m.isBot);
  if (!humans.length) {
    clearTimeout(room.botTimer);
    rooms.delete(room.code);
  } else {
    if (room.hostToken === user.token) {
      room.hostToken = humans[0].token;
      pushChat(room, null, `${humans[0].name}님이 새 방장이 되었습니다.`, true);
    }
    sendRoom(room);
    scheduleBots(room);
  }
}

function joinRoom(user, room) {
  if (user.roomCode === room.code) return;
  if (user.roomCode) leaveRoom(user);
  if (room.game && room.game.phase !== 'finished') throw new Error('이미 게임이 진행 중인 방입니다.');
  if (room.members.length >= room.maxPlayers) throw new Error('방이 가득 찼습니다.');
  room.members.push({ id: crypto.randomUUID(), token: user.token, name: user.name, avatar: user.avatar, isBot: false });
  user.roomCode = room.code;
  pushChat(room, null, `${user.name}님이 입장했습니다.`, true);
}

io.on('connection', (socket) => {
  let user = null;

  const handler = (fn) => (payload, ack) => {
    try {
      if (!user && fn.name !== 'hello') throw new Error('먼저 닉네임을 설정하세요.');
      const res = fn(payload || {});
      if (typeof ack === 'function') ack({ ok: true, ...(res || {}) });
    } catch (e) {
      if (typeof ack === 'function') ack({ ok: false, error: e.message });
    }
  };

  const myRoom = () => {
    const room = user && rooms.get(user.roomCode);
    if (!room) throw new Error('참여 중인 방이 없습니다.');
    return room;
  };
  const myMember = (room) => room.members.find((m) => m.token === user.token);
  const requireHost = (room) => {
    if (room.hostToken !== user.token) throw new Error('방장만 할 수 있습니다.');
  };

  socket.on('hello', handler(function hello({ token, name, avatar }) {
    const nick = clean(name, 12);
    if (!nick) throw new Error('닉네임을 입력하세요.');
    token = clean(token, 64);
    let u = token && users.get(token);
    if (!u) {
      token = crypto.randomUUID();
      u = { token, roomCode: null };
      users.set(token, u);
    }
    if (u.socketId && u.socketId !== socket.id) {
      io.to(u.socketId).emit('kicked', '다른 창에서 접속했습니다.');
    }
    u.name = nick;
    u.avatar = AVATARS.includes(avatar) ? avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
    u.socketId = socket.id;
    user = u;

    const room = rooms.get(u.roomCode);
    if (room) {
      const m = myMember(room);
      if (m) {
        m.name = u.name;
        m.avatar = u.avatar;
        sendRoom(room);
      } else u.roomCode = null;
    }
    broadcastLobby();
    return { token: u.token, name: u.name, avatar: u.avatar, avatars: AVATARS, roomCode: u.roomCode };
  }));

  socket.on('room:create', handler(function create({ name, maxPlayers, rounds }) {
    const code = newRoomCode();
    const room = {
      code,
      name: clean(name, 30) || `${user.name}님의 식스틴`,
      hostToken: user.token,
      maxPlayers: Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Number(maxPlayers) || 4)),
      rounds: Math.min(10, Math.max(1, Number(rounds) || 3)),
      members: [],
      chat: [],
      game: null,
      createdAt: Date.now(),
      touched: Date.now(),
    };
    rooms.set(code, room);
    joinRoom(user, room);
    sendRoom(room);
    broadcastLobby();
    return { code };
  }));

  socket.on('room:join', handler(function join({ code }) {
    const room = rooms.get(clean(code, 10).toUpperCase());
    if (!room) throw new Error('방을 찾을 수 없습니다.');
    joinRoom(user, room);
    sendRoom(room);
    broadcastLobby();
    return { code: room.code };
  }));

  socket.on('room:leave', handler(function leave() {
    leaveRoom(user);
    broadcastLobby();
  }));

  socket.on('room:addBot', handler(function addBot() {
    const room = myRoom();
    requireHost(room);
    if (room.game && room.game.phase !== 'finished') throw new Error('게임 중에는 봇을 추가할 수 없습니다.');
    if (room.members.length >= room.maxPlayers) throw new Error('방이 가득 찼습니다.');
    const used = new Set(room.members.map((m) => m.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `봇${room.members.length + 1}`;
    const id = crypto.randomUUID();
    room.members.push({ id, token: `bot:${id}`, name, avatar: '🤖', isBot: true });
    pushChat(room, null, `${name}이(가) 참가했습니다.`, true);
    sendRoom(room);
    broadcastLobby();
  }));

  socket.on('room:kick', handler(function kick({ id }) {
    const room = myRoom();
    requireHost(room);
    if (room.game && room.game.phase !== 'finished') throw new Error('게임 중에는 내보낼 수 없습니다.');
    const idx = room.members.findIndex((m) => m.id === id && m.token !== user.token);
    if (idx < 0) throw new Error('대상을 찾을 수 없습니다.');
    const [m] = room.members.splice(idx, 1);
    const u = users.get(m.token);
    if (u) {
      u.roomCode = null;
      if (u.socketId) io.to(u.socketId).emit('kicked', '방장에 의해 퇴장되었습니다.');
    }
    pushChat(room, null, `${m.name}님이 퇴장되었습니다.`, true);
    sendRoom(room);
    broadcastLobby();
  }));

  socket.on('room:settings', handler(function settings({ maxPlayers, rounds }) {
    const room = myRoom();
    requireHost(room);
    if (room.game && room.game.phase !== 'finished') throw new Error('게임 중에는 변경할 수 없습니다.');
    if (maxPlayers) room.maxPlayers = Math.min(MAX_PLAYERS, Math.max(room.members.length, MIN_PLAYERS, Number(maxPlayers)));
    if (rounds) room.rounds = Math.min(10, Math.max(1, Number(rounds)));
    sendRoom(room);
    broadcastLobby();
  }));

  socket.on('game:start', handler(function start() {
    const room = myRoom();
    requireHost(room);
    if (room.game && room.game.phase !== 'finished') throw new Error('이미 게임이 진행 중입니다.');
    if (room.members.length < MIN_PLAYERS) throw new Error(`최소 ${MIN_PLAYERS}명이 필요합니다. 봇을 추가해 보세요.`);
    room.game = new SixteenGame(
      room.members.map((m) => ({ id: m.id, name: m.name, isBot: m.isBot })),
      { rounds: room.rounds }
    );
    pushChat(room, null, '게임이 시작되었습니다! 행운을 빌어요 🍀', true);
    afterGameChange(room);
  }));

  socket.on('game:play', handler(function play({ tileIds }) {
    const room = myRoom();
    if (!room.game) throw new Error('게임이 시작되지 않았습니다.');
    const res = room.game.play(myMember(room).id, (tileIds || []).map(Number));
    afterGameChange(room);
    return res;
  }));

  socket.on('game:pass', handler(function pass() {
    const room = myRoom();
    if (!room.game) throw new Error('게임이 시작되지 않았습니다.');
    const res = room.game.pass(myMember(room).id);
    afterGameChange(room);
    return { drew: !!res.drew };
  }));

  socket.on('game:next', handler(function next() {
    const room = myRoom();
    requireHost(room);
    if (!room.game) throw new Error('게임이 시작되지 않았습니다.');
    room.game.nextRound();
    afterGameChange(room);
  }));

  socket.on('game:reset', handler(function reset() {
    const room = myRoom();
    requireHost(room);
    if (!room.game || room.game.phase !== 'finished') throw new Error('게임이 끝난 후에만 가능합니다.');
    room.game = null;
    room.members = room.members.filter((m) => !m.replaced);
    sendRoom(room);
    broadcastLobby();
  }));

  socket.on('chat:send', handler(function chat({ text }) {
    const room = myRoom();
    const msg = clean(text, 200);
    if (!msg) return;
    pushChat(room, { name: user.name, avatar: user.avatar, id: myMember(room).id }, msg);
    sendRoom(room);
  }));

  socket.on('disconnect', () => {
    if (!user || user.socketId !== socket.id) return;
    user.socketId = null;
    const room = rooms.get(user.roomCode);
    if (room) sendRoom(room);
    broadcastLobby();
  });
});

// 오래 방치된 방 정리
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyOnline = room.members.some((m) => !m.isBot && (users.get(m.token) || {}).socketId);
    if (!anyOnline && now - room.touched > ROOM_IDLE_MS) {
      clearTimeout(room.botTimer);
      for (const m of room.members) {
        const u = users.get(m.token);
        if (u) u.roomCode = null;
      }
      rooms.delete(room.code);
    }
  }
  broadcastLobby();
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Sixteen server listening on http://localhost:${PORT}`));
}

module.exports = { server, io };
