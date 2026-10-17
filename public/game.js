'use strict';

// ── Audio Manager ──────────────────────────────────────────────────────────
class AudioManager {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.recording = false;
    this._stopTimer = null;
  }

  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
    });
  }

  startRecording(onDone, maxMs = 5000) {
    if (this.recording) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this.chunks = [];
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', '']
      .find(t => !t || MediaRecorder.isTypeSupported(t));
    const options = mimeType ? { mimeType } : {};

    this.recorder = new MediaRecorder(this.stream, options);
    this.recorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.recorder.onstop = async () => {
      clearTimeout(this._stopTimer);
      const blob = new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' });
      try {
        const ab = await blob.arrayBuffer();
        const buffer = await this.ctx.decodeAudioData(ab);
        onDone(buffer);
      } catch (err) {
        console.error('decodeAudioData failed:', err);
        onDone(null);
      }
    };

    this.recorder.start(100);
    this.recording = true;
    this._stopTimer = setTimeout(() => this.stopRecording(), maxMs);
  }

  stopRecording() {
    if (!this.recording) return;
    clearTimeout(this._stopTimer);
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recording = false;
  }

  reverseBuffer(buf) {
    for (let c = 0; c < buf.numberOfChannels; c++) {
      Array.prototype.reverse.call(buf.getChannelData(c));
    }
    return buf;
  }

  cloneBuffer(buf) {
    const clone = this.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) clone.getChannelData(c).set(buf.getChannelData(c));
    return clone;
  }

  async play(buf, onended) {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    if (onended) src.onended = onended;
    src.start();
    return src;
  }

  bufferToBase64(buf) {
    const wav = this._encodeWAV(buf);
    const bytes = new Uint8Array(wav);
    let str = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      str += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(str);
  }

  async base64ToBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // slice(0) creates a copy so decodeAudioData can detach it
    return this.ctx.decodeAudioData(bytes.buffer.slice(0));
  }

  _encodeWAV(buf) {
    const sr = buf.sampleRate;
    let samples = buf.getChannelData(0);

    if (buf.numberOfChannels > 1) {
      const ch1 = buf.getChannelData(1);
      const mono = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) mono[i] = (samples[i] + ch1[i]) / 2;
      samples = mono;
    }

    const dataLen = samples.length * 2;
    const ab = new ArrayBuffer(44 + dataLen);
    const v = new DataView(ab);
    const s = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };

    s(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true);
    s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    s(36, 'data'); v.setUint32(40, dataLen, true);

    let off = 44;
    for (let i = 0; i < samples.length; i++) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
      off += 2;
    }
    return ab;
  }
}

// ── Game State ─────────────────────────────────────────────────────────────
const G = {
  socket: null,
  audio: null,
  name: '',
  roomCode: '',
  playerIndex: -1,
  role: null,
  round: 1,
  scores: [],
  speakerName: '',
  guesserName: '',
  options: [],
  celebrity: null,
  speakerAudioBuf: null,
  guesserAudioBuf: null,
  _guessTimer: null,
  _recInterval: null,
  _recSeconds: 0,
};

// ── DOM Helpers ────────────────────────────────────────────────────────────
const $app = () => document.getElementById('app');
const $id = (id) => document.getElementById(id);

function render(html) { $app().innerHTML = html; }

function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  requestAnimationFrame(() => { requestAnimationFrame(() => el.classList.add('show')); });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

function scoreboardHTML() {
  if (!G.scores.length) return '';
  return `<div class="scoreboard">${G.scores.map(s => `
    <div class="score-entry ${s.name === G.name ? 'me' : ''}">
      <span class="score-name">${esc(s.name)}</span>
      <span class="score-val">${s.score}</span>
    </div>`).join('')}</div>`;
}

function roundBadge() {
  return `<div class="round-badge">Round ${G.round}</div>`;
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Screens ────────────────────────────────────────────────────────────────

function showLanding() {
  render(`
    <div class="screen screen-landing">
      <div class="logo">
        <div class="logo-icon">🎙️</div>
        <h1>Echo<span>Clash</span></h1>
        <p class="tagline">Say it backwards. Guess it forwards. 😂</p>
      </div>
      <div class="card">
        <div class="field">
          <label>Your Name</label>
          <input id="inp-name" type="text" placeholder="e.g. Alex" maxlength="20" autocomplete="off" />
        </div>
        <div class="field">
          <label>Room Code <span class="hint">(share with your partner)</span></label>
          <div class="room-code-row">
            <input id="inp-room" type="text" placeholder="e.g. ECHO" maxlength="10" autocomplete="off" />
            <button id="btn-random" class="btn-ghost btn-small" title="Random code">🎲</button>
          </div>
        </div>
        <button id="btn-join" class="btn-primary btn-large">Join Game 🚀</button>
      </div>
      <p class="footer-note">Both players must enter the same room code!</p>
    </div>
  `);

  $id('inp-name').value = localStorage.getItem('lfg_name') || '';
  $id('inp-room').value = localStorage.getItem('lfg_room') || '';

  $id('btn-random').onclick = () => {
    $id('inp-room').value = Math.random().toString(36).slice(2, 7).toUpperCase();
  };

  $id('btn-join').onclick = joinRoom;
  $id('inp-name').addEventListener('keydown', e => { if (e.key === 'Enter') $id('inp-room').focus(); });
  $id('inp-room').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
}

function showWaiting(roomCode, players) {
  render(`
    <div class="screen screen-waiting">
      <h2>Waiting for your partner... ⏳</h2>
      <div class="card room-card">
        <p class="label">Room Code</p>
        <div class="room-code-display">${esc(roomCode)}</div>
        <button class="btn-ghost btn-small" id="btn-copy">📋 Copy Code</button>
      </div>
      <div class="players-list">
        ${players.map(p => `<div class="player-chip joined">✅ ${esc(p.name)}</div>`).join('')}
        ${players.length < 2 ? '<div class="player-chip waiting">👤 Waiting for player 2...</div>' : ''}
      </div>
      <div style="display:flex;justify-content:center"><div class="spinner"></div></div>
      <p class="hint-text" style="text-align:center">Share the room code with your partner to start!</p>
    </div>
  `);

  $id('btn-copy').onclick = () => {
    navigator.clipboard.writeText(roomCode)
      .then(() => toast('Room code copied!', 'success'))
      .catch(() => toast(`Room code: ${roomCode}`, 'info'));
  };
}

function showSpeakerSelect(options, round, scores) {
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner speaker">🎙️ You are the <strong>Speaker</strong></div>
      <h2>Choose a celebrity to say</h2>
      <p class="hint-text">Pick one — your partner will only hear your voice <em>reversed</em>!</p>
      <div class="celebrity-grid">
        ${options.map(c => `<button class="btn-celebrity" data-celeb="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      ${scoreboardHTML()}
    </div>
  `);

  document.querySelectorAll('.btn-celebrity').forEach(btn => {
    btn.onclick = () => selectCelebrity(btn.dataset.celeb);
  });
}

function showSpeakerRecord(celebrity) {
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner speaker">🎙️ Speaker</div>
      <h2>Say this name clearly:</h2>
      <div class="celebrity-name-display">${esc(celebrity)}</div>
      <div class="card">
        <p class="hint-text">Hold the button while you say the name, then release.</p>
        <div class="record-area">
          <button id="btn-record" class="btn-record" data-state="idle" style="display:flex">
            <span class="record-icon">🎤</span>
            <span class="record-label">Hold to Record</span>
          </button>
          <div id="rec-timer" class="record-timer hidden">5s</div>
        </div>
        <div id="preview-area" class="preview-area hidden">
          <p>🔀 Reversed preview (what your partner hears):</p>
          <button id="btn-preview" class="btn-secondary">▶ Play Reversed Preview</button>
          <button id="btn-send" class="btn-primary">Send to Partner ✈️</button>
          <button id="btn-rerecord" class="btn-ghost">🔄 Re-record</button>
        </div>
      </div>
    </div>
  `);

  setupRecordButton('speaker', (buf) => {
    if (!buf) { toast('Recording failed — try again', 'error'); return; }
    const reversed = G.audio.reverseBuffer(G.audio.cloneBuffer(buf));
    G.speakerAudioBuf = reversed;

    $id('preview-area').classList.remove('hidden');
    $id('btn-preview').onclick = () => G.audio.play(G.speakerAudioBuf);
    $id('btn-send').onclick = sendSpeakerAudio;
    $id('btn-rerecord').onclick = () => {
      G.speakerAudioBuf = null;
      $id('preview-area').classList.add('hidden');
      resetRecordBtn($id('btn-record'), 'Hold to Record');
    };
  });
}

function showSpeakerWait(guesserName) {
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner speaker">🎙️ Speaker</div>
      <div class="wait-content">
        <div class="wait-icon">🤔</div>
        <h2>${esc(guesserName)} is trying to guess...</h2>
        <p>Can they crack your reverse audio? 😏</p>
        <div class="pulse-ring"></div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);
}

function showGuesserWait(message) {
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner guesser">👂 You are the <strong>Guesser</strong></div>
      <div class="wait-content">
        <div class="wait-icon">✨</div>
        <h2>${esc(message)}</h2>
        <p>Get ready — you'll hear something completely weird 😂</p>
        <div class="spinner"></div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);
}

function showGuesserTurn(audioBuffer) {
  G.speakerAudioBuf = audioBuffer;
  G.guesserAudioBuf = null;

  render(`
    <div class="screen screen-guesser-turn">
      ${roundBadge()}
      <div class="role-banner guesser">👂 Guesser</div>

      <div class="step-card">
        <div class="step-num">Step 1 — Listen</div>
        <h3>Hear the reversed audio</h3>
        <button id="btn-play-rev" class="btn-secondary">▶ Play Reversed Audio</button>
        <p class="hint-text">Listen as many times as you need!</p>
      </div>

      <div class="step-card">
        <div class="step-num">Step 2 — Mimic</div>
        <h3>Record yourself mimicking those sounds</h3>
        <p class="hint-text">Repeat the backwards gibberish exactly as you heard it.</p>
        <div class="record-area">
          <button id="btn-record-mimic" class="btn-record btn-record-small" data-state="idle" style="display:flex">
            <span class="record-icon">🎤</span>
            <span class="record-label">Hold to Mimic</span>
          </button>
          <div id="mimic-timer" class="record-timer hidden">5s</div>
        </div>
      </div>

      <div class="step-card hidden" id="step3">
        <div class="step-num">Step 3 — Hear it forward</div>
        <h3>Play your reversed mimic</h3>
        <p class="hint-text">This should sound like the original name!</p>
        <button id="btn-play-mimic" class="btn-secondary">▶ Play Your Reversed Mimic</button>
        <button id="btn-rerecord-mimic" class="btn-ghost">🔄 Re-record mimic</button>
      </div>

      <div class="step-card">
        <div class="step-num">Step 4 — Guess!</div>
        <h3>What celebrity did you hear?</h3>
        <input id="inp-guess" type="text" class="guess-input" placeholder="Type celebrity name..." autocomplete="off" />
        <button id="btn-submit" class="btn-primary" disabled>Submit Guess 🎯</button>
        <div class="guess-timer"><span id="timer-display">⏱ 60s</span></div>
      </div>
    </div>
  `);

  setupGuesserTurn();
}

function showReveal(result) {
  const { guess, correct, celebrity, guesserPoints, speakerPoints, timeTaken,
          scores, speakerAudio, guesserAudio, speakerName, guesserName } = result;

  G.scores = scores;

  render(`
    <div class="screen">
      ${roundBadge()}

      <div class="reveal-result ${correct ? 'correct' : 'wrong'}">
        <div class="result-icon">${correct ? '🎉' : '😅'}</div>
        <h2>${correct ? 'Correct!' : 'Wrong!'}</h2>
        <p class="guess-display">Guess: "<strong>${esc(guess)}</strong>"</p>
        <div class="celebrity-reveal">
          <span>The answer was:</span>
          <strong class="celebrity-answer">${esc(celebrity)}</strong>
        </div>
      </div>

      <div class="points-breakdown">
        ${guesserPoints > 0 ? `
          <div class="points earned">
            <span>🏆 ${esc(guesserName)}</span>
            <span>+${guesserPoints} pts${timeTaken !== undefined ? ` ⚡ ${timeTaken}s` : ''}</span>
          </div>` : ''}
        ${speakerPoints > 0 ? `
          <div class="points earned">
            <span>🎙️ ${esc(speakerName)} (great recording!)</span>
            <span>+${speakerPoints} pts</span>
          </div>` : ''}
        ${guesserPoints === 0 && speakerPoints === 0 ? `
          <div class="points none">No points this round</div>` : ''}
      </div>

      ${scoreboardHTML()}

      <div class="audio-playback">
        <h3>🎧 Listen back for laughs:</h3>
        <div class="audio-btns">
          ${speakerAudio ? `<button id="btn-play-spk" class="btn-audio">🔀 ${esc(speakerName)}'s reversed voice</button>` : ''}
          ${guesserAudio ? `<button id="btn-play-gsr" class="btn-audio">🔀 ${esc(guesserName)}'s reversed mimic</button>` : ''}
        </div>
      </div>

      <button id="btn-next" class="btn-primary btn-large">Next Round ➡️</button>
    </div>
  `);

  if (speakerAudio) {
    $id('btn-play-spk').onclick = async () => {
      try {
        const buf = await G.audio.base64ToBuffer(speakerAudio);
        await G.audio.play(buf);
      } catch { toast('Could not play audio', 'error'); }
    };
  }

  if (guesserAudio) {
    $id('btn-play-gsr').onclick = async () => {
      try {
        const buf = await G.audio.base64ToBuffer(guesserAudio);
        await G.audio.play(buf);
      } catch { toast('Could not play audio', 'error'); }
    };
  }

  $id('btn-next').onclick = () => {
    $id('btn-next').disabled = true;
    $id('btn-next').textContent = '...';
    G.socket.emit('next_round');
  };
}

// ── Recording Helpers ──────────────────────────────────────────────────────

function resetRecordBtn(btn, label) {
  if (!btn) return;
  btn.dataset.state = 'idle';
  const lbl = btn.querySelector('.record-label');
  if (lbl) lbl.textContent = label;
}

function setupRecordButton(role, onDone) {
  const btnId = role === 'speaker' ? 'btn-record' : 'btn-record-mimic';
  const timerId = role === 'speaker' ? 'rec-timer' : 'mimic-timer';
  const btn = $id(btnId);
  if (!btn) return;

  const startRec = (e) => {
    e.preventDefault();
    if (btn.dataset.state !== 'idle') return;
    btn.dataset.state = 'recording';
    const lbl = btn.querySelector('.record-label');
    if (lbl) lbl.textContent = 'Recording... Release to stop';

    G._recSeconds = 5;
    const timerEl = $id(timerId);
    if (timerEl) { timerEl.textContent = `${G._recSeconds}s`; timerEl.classList.remove('hidden'); }

    G._recInterval = setInterval(() => {
      G._recSeconds--;
      if (timerEl) timerEl.textContent = `${G._recSeconds}s`;
      if (G._recSeconds <= 0) {
        clearInterval(G._recInterval);
        G.audio.stopRecording();
      }
    }, 1000);

    G.audio.startRecording((buf) => {
      clearInterval(G._recInterval);
      if (timerEl) timerEl.classList.add('hidden');

      if (!buf) {
        resetRecordBtn(btn, role === 'speaker' ? 'Hold to Record' : 'Hold to Mimic');
        onDone(null);
        return;
      }

      btn.dataset.state = 'done';
      const lbl2 = btn.querySelector('.record-label');
      if (lbl2) lbl2.textContent = 'Recorded ✓';
      onDone(buf);
    });
  };

  const stopRec = (e) => {
    e.preventDefault();
    if (btn.dataset.state !== 'recording') return;
    clearInterval(G._recInterval);
    G.audio.stopRecording();
    const lbl = btn.querySelector('.record-label');
    if (lbl) lbl.textContent = 'Processing...';
  };

  btn.addEventListener('mousedown', startRec);
  btn.addEventListener('touchstart', startRec, { passive: false });
  btn.addEventListener('mouseup', stopRec);
  btn.addEventListener('touchend', stopRec, { passive: false });
  btn.addEventListener('mouseleave', (e) => { if (btn.dataset.state === 'recording') stopRec(e); });
}

// ── Speaker Actions ────────────────────────────────────────────────────────

function selectCelebrity(celebrity) {
  G.celebrity = celebrity;
  G.socket.emit('select_celebrity', { celebrity });
  showSpeakerRecord(celebrity);
}

async function sendSpeakerAudio() {
  if (!G.speakerAudioBuf) return;
  const btn = $id('btn-send');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending... ✈️'; }

  try {
    const b64 = G.audio.bufferToBase64(G.speakerAudioBuf);
    G.socket.emit('speaker_audio', { audioBase64: b64 });
  } catch (err) {
    console.error(err);
    toast('Failed to send audio. Try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Send to Partner ✈️'; }
  }
}

// ── Guesser Actions ────────────────────────────────────────────────────────

function setupGuesserTurn() {
  $id('btn-play-rev').onclick = () => G.audio.play(G.speakerAudioBuf);

  setupRecordButton('guesser', (buf) => {
    if (!buf) { toast('Recording failed — try again', 'error'); return; }

    const reversed = G.audio.reverseBuffer(G.audio.cloneBuffer(buf));
    G.guesserAudioBuf = reversed;

    // Send to server for reveal
    try {
      const b64 = G.audio.bufferToBase64(reversed);
      G.socket.emit('guesser_audio', { audioBase64: b64 });
    } catch (e) { console.error('Failed to send guesser audio:', e); }

    $id('step3').classList.remove('hidden');
    $id('btn-play-mimic').onclick = () => G.audio.play(G.guesserAudioBuf);
    $id('btn-rerecord-mimic').onclick = () => {
      G.guesserAudioBuf = null;
      $id('step3').classList.add('hidden');
      resetRecordBtn($id('btn-record-mimic'), 'Hold to Mimic');
    };
  });

  // Guess input
  const inp = $id('inp-guess');
  const btn = $id('btn-submit');

  inp.addEventListener('input', () => { btn.disabled = !inp.value.trim(); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) submitGuess(); });
  btn.onclick = submitGuess;

  // 60-second countdown
  clearInterval(G._guessTimer);
  let timeLeft = 60;
  const timerEl = $id('timer-display');
  if (timerEl) timerEl.textContent = '⏱ 60s';
  G._guessTimer = setInterval(() => {
    timeLeft--;
    const el = $id('timer-display');
    if (!el) { clearInterval(G._guessTimer); return; }
    el.textContent = `⏱ ${timeLeft}s`;
    if (timeLeft <= 10) el.classList.add('timer-warning');
    if (timeLeft <= 0) {
      clearInterval(G._guessTimer);
      el.textContent = '⏱ Time up!';
      G.socket.emit('submit_guess', { guess: inp.value.trim() || '' });
      btn.disabled = true;
    }
  }, 1000);
}

function submitGuess() {
  clearInterval(G._guessTimer);
  const inp = $id('inp-guess');
  const btn = $id('btn-submit');
  const guess = inp ? inp.value.trim() : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Submitted! ⏳'; }
  G.socket.emit('submit_guess', { guess });
}

// ── Socket ─────────────────────────────────────────────────────────────────

function setupSocket() {
  const s = G.socket;

  s.on('connect_error', () => toast('Connection error. Check your internet.', 'error'));
  s.on('disconnect', () => toast('Disconnected from server.', 'error'));

  s.on('room_joined', ({ roomCode, players, yourIndex }) => {
    G.roomCode = roomCode;
    G.playerIndex = yourIndex;
    showWaiting(roomCode, players);
  });

  s.on('player_joined', ({ playerName, players }) => {
    toast(`${playerName} joined! Starting... 🎉`, 'success');
    showWaiting(G.roomCode, players);
  });

  s.on('your_turn_speaker', ({ options, round, speakerName, guesserName, scores }) => {
    G.round = round;
    G.scores = scores;
    G.role = 'speaker';
    G.speakerName = speakerName;
    G.guesserName = guesserName;
    G.options = options;
    showSpeakerSelect(options, round, scores);
  });

  s.on('your_turn_guesser', ({ round, speakerName, guesserName, scores }) => {
    G.round = round;
    G.scores = scores;
    G.role = 'guesser';
    G.speakerName = speakerName;
    G.guesserName = guesserName;
    showGuesserWait(`${speakerName} is choosing a celebrity...`);
  });

  s.on('celebrity_confirmed', () => {
    // Speaker already on recording screen, no action needed
  });

  s.on('speaker_recording', () => {
    if (G.role === 'guesser') showGuesserWait(`${G.speakerName} is recording... 🎙️`);
  });

  s.on('waiting_for_guesser', () => {
    if (G.role === 'speaker') showSpeakerWait(G.guesserName);
  });

  s.on('reversed_audio', async ({ audioBase64 }) => {
    try {
      const buf = await G.audio.base64ToBuffer(audioBase64);
      showGuesserTurn(buf);
    } catch (err) {
      console.error('Failed to decode audio:', err);
      toast('Audio error. Please refresh.', 'error');
    }
  });

  s.on('round_result', (result) => {
    clearInterval(G._guessTimer);
    showReveal(result);
  });

  s.on('player_disconnected', ({ playerName }) => {
    toast(`${playerName} disconnected 😢`, 'error');
  });

  s.on('error', ({ message }) => {
    toast(message, 'error');
  });
}

// ── Join Room ──────────────────────────────────────────────────────────────

async function joinRoom() {
  const nameEl = $id('inp-name');
  const roomEl = $id('inp-room');

  const name = nameEl.value.trim();
  const room = (roomEl.value.trim().toUpperCase() || 'ECHO').replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'ECHO';

  if (!name) { toast('Please enter your name!', 'error'); nameEl.focus(); return; }

  const btn = $id('btn-join');
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting... 🎤'; }

  // Request mic permission first
  try {
    G.audio = new AudioManager();
    await G.audio.init();
  } catch (err) {
    console.error(err);
    toast('Microphone access required. Please allow it and try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Join Game 🚀'; }
    return;
  }

  G.name = name;
  G.roomCode = room;
  localStorage.setItem('lfg_name', name);
  localStorage.setItem('lfg_room', room);

  G.socket = io({ transports: ['websocket', 'polling'] });
  setupSocket();
  G.socket.emit('join_room', { roomCode: room, playerName: name });
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', showLanding);
