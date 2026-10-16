'use strict';

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10e6, // 10MB for base64 audio
  pingTimeout: 60000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Celebrity Pool ──────────────────────────────────────────────────────────
const CELEBRITIES = [
  'Justin Bieber', 'Ariana Grande', 'Michael Jackson', 'Lionel Messi',
  'Cristiano Ronaldo', 'Taylor Swift', 'Drake', 'Zendaya', 'Neymar',
  'Beyoncé', 'Rihanna', 'Eminem', 'Billie Eilish', 'Harry Styles',
  'Dua Lipa', 'Bad Bunny', 'Cardi B', 'The Weeknd', 'Bruno Mars',
  'Lady Gaga', 'Shakira', 'LeBron James', 'Elon Musk', 'Selena Gomez',
  'Post Malone', 'Ed Sheeran', 'Adele', 'Katy Perry', 'Miley Cyrus',
  'Travis Scott', 'Celine Dion', 'Mariah Carey', 'Elvis Presley',
  'Freddie Mercury', 'David Beckham', 'Tiger Woods', 'Serena Williams',
];

// ── Fuzzy Matching ──────────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = i === 0 ? j : a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], row[j - 1], dp[i - 1][j - 1]);
    }
    return row;
  });
  return dp[m][n];
}

function normalize(s) {
  return s.toLowerCase().trim()
    .replace(/[éèê]/g, 'e').replace(/[áàâ]/g, 'a')
    .replace(/[íìî]/g, 'i').replace(/[óòô]/g, 'o')
    .replace(/[úùû]/g, 'u').replace(/[^a-z0-9 ]/g, '');
}

function fuzzyMatch(guess, target) {
  const g = normalize(guess);
  const t = normalize(target);
  if (!g) return false;
  if (g === t) return true;

  const tParts = t.split(' ').filter(p => p.length > 2);
  for (const part of tParts) {
    if (g === part) return true;
    if (g.includes(part) || part.includes(g)) return true;
  }

  const dist = levenshtein(g, t);
  return dist / Math.max(g.length, t.length) < 0.35;
}

function getRandomOptions(count = 5, exclude = []) {
  const pool = CELEBRITIES.filter(c => !exclude.includes(c));
  return pool.sort(() => Math.random() - 0.5).slice(0, count);
}

// ── Room State ──────────────────────────────────────────────────────────────
const rooms = new Map();

function createRoom(code) {
  return {
    code,
    players: [],          // [{id, name, score, connected}]
    phase: 'waiting',
    round: 1,
    speakerIndex: 0,
    selectedCelebrity: null,
    speakerAudio: null,   // base64 reversed WAV from speaker
    guesserAudio: null,   // base64 reversed WAV from guesser's mimic
    roundStartTime: null,
    options: [],
    usedCelebrities: [],
  };
}

function roomOf(socket) {
  return rooms.get(socket.roomCode);
}

function otherPlayer(room, socketId) {
  return room.players.find(p => p.id !== socketId);
}

function startRound(io, room) {
  room.options = getRandomOptions(5, room.usedCelebrities);
  const speaker = room.players[room.speakerIndex];
  const guesserIdx = 1 - room.speakerIndex;
  const guesser = room.players[guesserIdx];

  const scores = room.players.map(p => ({ name: p.name, score: p.score }));

  io.to(speaker.id).emit('your_turn_speaker', {
    options: room.options,
    round: room.round,
    speakerName: speaker.name,
    guesserName: guesser.name,
    scores,
  });

  io.to(guesser.id).emit('your_turn_guesser', {
    round: room.round,
    speakerName: speaker.name,
    guesserName: guesser.name,
    scores,
  });
}

// ── Socket Handlers ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = (roomCode || 'LAYNIE').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'LAYNIE';
    const name = (playerName || 'Player').trim().slice(0, 20);

    if (!rooms.has(code)) rooms.set(code, createRoom(code));
    const room = rooms.get(code);

    if (room.players.length >= 2 && !room.players.find(p => p.name === name)) {
      socket.emit('error', { message: 'Room is full!' });
      return;
    }

    // Handle reconnect
    const existing = room.players.find(p => p.name === name);
    if (existing) {
      existing.id = socket.id;
      existing.connected = true;
    } else {
      room.players.push({ id: socket.id, name, score: 0, connected: true });
    }

    socket.roomCode = code;
    socket.join(code);

    socket.emit('room_joined', {
      roomCode: code,
      players: room.players.map(p => ({ name: p.name, score: p.score })),
      yourIndex: room.players.findIndex(p => p.id === socket.id),
    });

    socket.to(code).emit('player_joined', {
      playerName: name,
      players: room.players.map(p => ({ name: p.name, score: p.score })),
    });

    if (room.players.length === 2 && room.phase === 'waiting') {
      room.phase = 'celebrity_selection';
      setTimeout(() => startRound(io, room), 500);
    }
  });

  socket.on('select_celebrity', ({ celebrity }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'celebrity_selection') return;
    if (room.players[room.speakerIndex].id !== socket.id) return;
    if (!room.options.includes(celebrity)) return;

    room.selectedCelebrity = celebrity;
    room.usedCelebrities.push(celebrity);
    room.phase = 'speaker_recording';

    socket.emit('celebrity_confirmed', { celebrity });

    const other = otherPlayer(room, socket.id);
    if (other) io.to(other.id).emit('speaker_recording', {});
  });

  socket.on('speaker_audio', ({ audioBase64 }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'speaker_recording') return;
    if (room.players[room.speakerIndex].id !== socket.id) return;

    room.speakerAudio = audioBase64;
    room.phase = 'guesser_turn';
    room.roundStartTime = Date.now();

    socket.emit('waiting_for_guesser', {});

    const other = otherPlayer(room, socket.id);
    if (other) io.to(other.id).emit('reversed_audio', { audioBase64 });
  });

  socket.on('guesser_audio', ({ audioBase64 }) => {
    const room = roomOf(socket);
    if (!room) return;
    room.guesserAudio = audioBase64;
  });

  socket.on('submit_guess', ({ guess }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'guesser_turn') return;

    const guesserIdx = 1 - room.speakerIndex;
    if (room.players[guesserIdx].id !== socket.id) return;

    room.phase = 'reveal';

    const correct = fuzzyMatch(guess || '', room.selectedCelebrity);
    const elapsed = (Date.now() - room.roundStartTime) / 1000;
    const speedBonus = elapsed < 60 && correct;

    let guesserPoints = 0;
    let speakerPoints = 0;

    if (correct) {
      guesserPoints = 100 + (speedBonus ? 20 : 0);
    } else {
      speakerPoints = 50;
    }

    room.players[guesserIdx].score += guesserPoints;
    room.players[room.speakerIndex].score += speakerPoints;

    io.to(room.code).emit('round_result', {
      guess: guess || '(no guess)',
      correct,
      celebrity: room.selectedCelebrity,
      guesserPoints,
      speakerPoints,
      speedBonus,
      scores: room.players.map(p => ({ name: p.name, score: p.score })),
      speakerAudio: room.speakerAudio,
      guesserAudio: room.guesserAudio,
      speakerName: room.players[room.speakerIndex].name,
      guesserName: room.players[guesserIdx].name,
    });
  });

  socket.on('next_round', () => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'reveal') return;

    room.round++;
    room.speakerIndex = 1 - room.speakerIndex;
    room.selectedCelebrity = null;
    room.speakerAudio = null;
    room.guesserAudio = null;
    room.phase = 'celebrity_selection';

    startRound(io, room);
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.connected = false;
      socket.to(room.code).emit('player_disconnected', { playerName: player.name });
    }
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`LayniFahmi Game running on port ${PORT}`));
