/**
 * 화면 흐름과 게임 진행.
 *
 *   대기(idle) ──시작──> 재생(playing) ──결과 확인──> 공개(reveal) ──다음 곡──> 대기
 *
 * 재생 화면에서는 곡 정보를 어떤 형태로도 노출하지 않는다. 이 게임의 전제이기 때문에
 * 앨범아트/제목은 공개 화면으로 넘어가기 전까지 DOM 에 넣지 않는다.
 *
 * 재생 엔진(iTunes / Spotify)은 AudioProvider 뒤에 숨어 있어서
 * 아래 게임 로직은 어느 엔진이 붙어 있는지 알 필요가 없다.
 */

(() => {
  'use strict';

  const app = document.getElementById('app');
  const $ = (id) => document.getElementById(id);

  const el = {
    remaining: $('deck-remaining'), range: $('deck-range'),
    start: $('btn-start'), toggle: $('btn-toggle'), toggleCaption: $('toggle-caption'),
    reveal: $('btn-reveal'), replay: $('btn-replay'), replay2: $('btn-replay-2'),
    next: $('btn-next'), reset: $('btn-reset'), retry: $('btn-retry'),
    progress: $('progress'), progressFill: $('progress-fill'),
    timeCurrent: $('time-current'), timeTotal: $('time-total'),
    art: $('reveal-art'), year: $('reveal-year'), artist: $('reveal-artist'),
    title: $('reveal-title'), album: $('reveal-album'),
    errorMessage: $('error-message'), doneCount: $('done-count'),
    settings: $('btn-settings'), sheet: $('sheet'),
    chips: $('decade-chips'), filterCount: $('filter-count'),
    volume: $('volume'), startAt: $('startat'), startAtValue: $('startat-value'),
    startAtNote: $('startat-note'),
    optAutoplay: $('opt-autoplay'), optKeepAwake: $('opt-keepawake'),
    optGyro: $('opt-gyro'), gyroNote: $('gyro-note'), flipPrompt: $('flip-prompt'),
    reshuffle: $('btn-reshuffle'),
    engineChips: $('engine-chips'), spotifySetup: $('spotify-setup'),
    spotifyStatus: $('spotify-status'), spotifyClient: $('spotify-client'),
    redirectUri: $('redirect-uri'), copyRedirect: $('btn-copy-redirect'),
    spotifyLogin: $('btn-spotify-login'), spotifyLogout: $('btn-spotify-logout'),
    qrBtn: $('btn-qr'), qrBox: $('qr-box'), qrCanvas: $('qr-canvas'),
    diagBtn: $('btn-diagnose'), diag: $('diag'),
    auditBtn: $('btn-audit'), audit: $('audit'), auditList: $('audit-list'),
    auditProgress: $('audit-progress'), auditStop: $('btn-audit-stop'),
    auditCopy: $('btn-audit-copy'), auditExport: $('btn-audit-export'), auditText: $('audit-text'),
    modeChips: $('mode-chips'), modeNote: $('mode-note'),
    work: $('reveal-work'), workType: $('reveal-worktype'),
    characters: $('reveal-characters'), ostSong: $('reveal-ost-song'),
  };

  const PREFS_KEY = 'music-game/prefs/v1';
  const DEFAULTS = {
    volume: 85, autoplay: true, keepAwake: true,
    from: null, to: null, startAt: 0, gyro: false, engine: 'itunes', mode: 'kpop',
  };
  // iTunes 는 30초 클립이라 시작 위치를 길게 줄 수 없다. Spotify 는 풀 트랙이라 여유가 있다.
  const START_MAX = { itunes: 15, spotify: 90 };

  const deck = new Deck(loadPrefs().mode);
  const flip = new FlipDetector();
  const prefetcher = new Prefetcher();

  let player = null;          // 지금 곡을 맡은 쪽
  let spotifyPlayer = null;   // 풀 트랙 (주소를 아는 곡만)
  let itunesPlayer = null;    // 30초 미리듣기 (언제나 된다)
  let currentSong = null;
  let wakeLock = null;
  const prefs = loadPrefs();

  // ---------- 설정 저장 ----------
  function loadPrefs() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
    catch (_) { return { ...DEFAULTS }; }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  // ---------- 화면 ----------
  function show(screen) {
    app.dataset.screen = screen;
    if (screen !== 'playing') { flip.stop(); el.flipPrompt.hidden = true; }
    if (screen === 'idle' || screen === 'done') releaseWakeLock();
  }
  function setPlayingFlag(on) {
    app.dataset.playing = String(on);
    el.toggleCaption.textContent = on ? '일시정지' : '재생';
  }
  function fmt(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  }
  function refreshIdle() {
    el.remaining.textContent = deck.remaining;
    const { from, to } = deck.filter;
    el.range.textContent = from || to
      ? `${from ?? '처음'} – ${to ?? '현재'}`
      : `전체 ${deck.total}곡 중`;
  }
  function fail(message) {
    el.errorMessage.textContent = message;
    show('error');
  }

  // ---------- 재생 엔진 ----------
  function wirePlayer(p) {
    p.on('timeupdate', ({ current, duration }) => {
      el.progressFill.style.width = `${Math.min(100, duration ? (current / duration) * 100 : 0)}%`;
      el.timeCurrent.textContent = fmt(current);
      if (duration) el.timeTotal.textContent = fmt(duration);
    });
    p.on('play', () => setPlayingFlag(true));
    p.on('pause', () => setPlayingFlag(false));
    p.on('ended', () => { setPlayingFlag(false); el.progressFill.style.width = '100%'; });
    p.on('error', (err) => {
      console.warn('재생 엔진 오류:', err);
      setSpotifyStatus(err.message, 'warn');
    });
    return p;
  }

  /** 엔진을 교체한다. Spotify 연결에 실패하면 예외를 던지고 호출부가 iTunes 로 되돌린다. */
  async function setEngine(name) {
    for (const p of [spotifyPlayer, itunesPlayer]) {
      if (p) { try { p.stop(); p.destroy?.(); } catch (_) {} }
    }
    spotifyPlayer = null;
    itunesPlayer = wirePlayer(new ItunesPreviewProvider());
    player = itunesPlayer;

    if (name === 'spotify') {
      if (typeof SpotifyProvider === 'undefined' || !SpotifyAuth.isLoggedIn) {
        throw new Error('Spotify 로그인이 필요합니다');
      }
      const sp = wirePlayer(new SpotifyProvider());
      await sp.connect();          // Premium 아님 / 기기 연결 실패가 여기서 걸린다
      spotifyPlayer = sp;
      player = sp;
    }

    prefs.engine = name;
    savePrefs();
    setVolume(prefs.volume);
    applyEngineUi();
  }

  /** 모든 엔진에 소리 크기를 맞춘다. 곡마다 엔진이 바뀌므로 한쪽만 하면 안 된다. */
  function setVolume(percent) {
    for (const p of [spotifyPlayer, itunesPlayer]) if (p) p.volume = percent / 100;
  }

  /**
   * 이 곡을 어느 엔진으로 틀지 고른다.
   *
   * Spotify 개발 모드 할당량은 개발자 계정 단위로 매겨져, 한 번 바닥나면
   * 하루가 지나도 새 곡을 찾지 못한다. 주소를 미리 박아 둔 곡만 풀 트랙으로
   * 나오고 나머지는 라운드가 통째로 멈추는데, 파티 중에 그런 일이 나면 안 된다.
   * 주소를 모르는 곡은 30초 미리듣기로라도 넘긴다.
   */
  function pickPlayer(song) {
    if (spotifyPlayer && song.spotifyUri) return spotifyPlayer;
    return itunesPlayer;
  }

  function applyEngineUi() {
    [...el.engineChips.querySelectorAll('.chip')].forEach((c) =>
      c.setAttribute('aria-pressed', String(c.dataset.engine === prefs.engine))
    );
    el.spotifySetup.hidden = prefs.engine !== 'spotify';

    const max = START_MAX[prefs.engine] ?? 15;
    el.startAt.max = max;
    if (prefs.startAt > max) { prefs.startAt = max; savePrefs(); }
    el.startAt.value = prefs.startAt;
    el.startAtValue.textContent = `${prefs.startAt}초`;
    el.startAtNote.textContent = prefs.engine === 'spotify'
      ? '원곡 전체를 재생합니다. 0초로 두면 노래 맨 처음부터 나옵니다.'
      : '미리듣기는 애플이 잘라둔 30초 구간입니다. 그 안에서 몇 초 뒤부터 틀지 정할 수 있습니다.';
  }

  function setSpotifyStatus(text, kind = '') {
    el.spotifyStatus.textContent = text || '';
    el.spotifyStatus.className = 'field-note' + (kind ? ` status-${kind}` : '');
  }

  // ---------- 화면 꺼짐 방지 ----------
  async function requestWakeLock() {
    if (!prefs.keepAwake || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) {}
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.dataset.screen === 'playing') requestWakeLock();
  });

  // ---------- 게임 진행 ----------
  async function startRound(depth = 0) {
    const song = deck.draw();
    if (!song) { showDone(); return; }
    currentSong = song;

    const next = pickPlayer(song);
    if (player && player !== next) { try { player.stop(); } catch (_) {} }
    player = next;

    show('playing');
    setPlayingFlag(false);
    el.progressFill.style.width = '0%';
    el.timeCurrent.textContent = '0:00';
    el.timeTotal.textContent = player === spotifyPlayer ? '--:--' : '0:30';
    requestWakeLock();

    try {
      await player.load(song);
      if (player.duration) el.timeTotal.textContent = fmt(player.duration);

      if (prefs.gyro) {
        el.flipPrompt.hidden = false;
        flip.start();
      } else if (prefs.autoplay) {
        await player.playFrom(prefs.startAt);
      }
    } catch (err) {
      console.warn('재생 실패:', song.artist, '-', song.title || song.work, err);
      // 그 곡만의 문제면 넘어가되, 연달아 실패하면 엔진 쪽 문제이므로 멈추고 알린다.
      if (depth < 3 && deck.remaining > 0) { startRound(depth + 1); return; }
      fail(err.message || '곡을 재생할 수 없습니다. 네트워크와 재생 엔진 설정을 확인해 주세요.');
      return;
    }

    if (prefs.engine === 'itunes') {
      prefetcher.warm(deck.peek(0));
      prefetcher.warm(deck.peek(1));
    }
  }

  async function togglePlay() {
    try {
      if (player.isPlaying) player.pause();
      else if (player.currentTime > 0) await player.play();
      else await player.playFrom(prefs.startAt);
    } catch (err) { console.warn('재생 토글 실패:', err); }
  }

  /** 제목 길이에 따라 글자 크기를 낮춰 카드 밖으로 넘치지 않게 한다. */
  function sizedTitle(node, text) {
    node.textContent = text;
    node.className = 'reveal-title' +
      (text.length > 22 ? ' is-very-long' : text.length > 13 ? ' is-long' : '');
  }

  function revealAnswer() {
    if (!currentSong) return;
    player.pause();
    const s = currentSong;
    el.year.textContent = s.year;
    el.album.textContent = s.album || '';

    if (prefs.mode === 'ost') {
      // OST 모드의 정답은 작품 제목과 주연 배역 이름이다. 곡은 참고로만 보여준다.
      el.workType.textContent = s.workType === 'drama' ? '드라마' : '영화';
      sizedTitle(el.work, s.work);
      el.characters.innerHTML = '';
      (s.characters || []).forEach((c) => {
        const li = document.createElement('li');
        li.textContent = c.name;
        if (c.actor) {
          const span = document.createElement('span');
          span.className = 'actor';
          span.textContent = ` (${c.actor})`;
          li.appendChild(span);
        }
        el.characters.appendChild(li);
      });
      el.ostSong.textContent = s.artist ? `OST · ${s.artist} — ${s.song}` : `OST · ${s.song}`;
      setArt(s, `${s.work} 포스터 이미지`);
    } else {
      el.artist.textContent = s.artist;
      sizedTitle(el.title, s.title);
      setArt(s, `${s.artist} - ${s.title} 앨범 이미지`);
    }
    show('reveal');
  }

  function setArt(s, alt) {
    if (s.artwork) { el.art.src = s.artwork; el.art.alt = alt; }
    else { el.art.removeAttribute('src'); el.art.alt = ''; }
  }

  function nextRound() {
    player.stop();
    currentSong = null;
    if (deck.isEmpty) { showDone(); return; }
    refreshIdle();
    show('idle');
  }

  function showDone() {
    player?.stop();
    el.doneCount.textContent = `${deck.total}곡을 모두 사용했습니다`;
    show('done');
  }

  el.progress.addEventListener('click', (e) => {
    const rect = el.progress.getBoundingClientRect();
    player.seek(((e.clientX - rect.left) / rect.width) * player.duration);
  });

  // ---------- 설정: 연대 ----------
  /**
   * 연대 목록은 데이터에서 뽑는다.
   * OST 모드에는 1939년 작품까지 있어 고정 목록(1980~2020)으로는 그 이전이 빠진다.
   */
  function decadeList() {
    if (!deck.all.length) return [];
    const { min, max } = deck.yearBounds;
    const out = [];
    for (let d = Math.floor(min / 10) * 10; d <= Math.floor(max / 10) * 10; d += 10) out.push(d);
    return out;
  }

  function buildChips() {
    el.chips.innerHTML = '';
    const mk = (label, from, to, count) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.innerHTML = `${label}<span class="chip-count">${count}</span>`;
      b.setAttribute('aria-pressed', String(deck.filter.from === from && deck.filter.to === to));
      // 곡이 없는 연대는 눌러도 게임이 안 되므로 막되, 숨기지는 않는다.
      if (count === 0) {
        b.disabled = true;
        b.title = '이 연대에 곡이 아직 없습니다';
      } else {
        b.addEventListener('click', () => {
          prefs.from = from; prefs.to = to; savePrefs();
          deck.applyFilter({ from, to });
          buildChips(); refreshIdle();
          if (app.dataset.screen === 'done') show('idle');
        });
      }
      el.chips.appendChild(b);
    };
    mk('전체', null, null, deck.all.length);
    // 곡이 아주 적은 연대는 따로 두면 게임이 안 되므로 인접 연대와 묶어 보여준다
    const decades = decadeList();
    const shown = decades.filter((d) => deck.countInRange(d, d + 9) > 0);
    if (shown.length && shown[0] < 1980) {
      const early = shown.filter((d) => d < 1980);
      const from = early[0], to = 1979;
      mk(`${from}~70년대`, from, to, deck.countInRange(from, to));
    }
    decades.filter((d) => d >= 1980)
           .forEach((d) => mk(`${d}년대`, d, d + 9, deck.countInRange(d, d + 9)));
    const { from, to } = deck.filter;
    el.filterCount.textContent = `선택된 범위에 ${deck.countInRange(from, to)}곡이 있습니다`;
  }

  // ---------- 설정: 시트 ----------
  el.settings.addEventListener('click', () => { buildChips(); el.sheet.hidden = false; });
  el.sheet.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) el.sheet.hidden = true;
  });

  el.volume.addEventListener('input', () => {
    prefs.volume = Number(el.volume.value);
    setVolume(prefs.volume);
    savePrefs();
  });
  el.startAt.addEventListener('input', () => {
    prefs.startAt = Number(el.startAt.value);
    el.startAtValue.textContent = `${prefs.startAt}초`;
    savePrefs();
  });
  el.optAutoplay.addEventListener('change', () => {
    prefs.autoplay = el.optAutoplay.checked; savePrefs();
  });
  el.optKeepAwake.addEventListener('change', () => {
    prefs.keepAwake = el.optKeepAwake.checked; savePrefs();
    if (!prefs.keepAwake) releaseWakeLock();
  });
  el.reshuffle.addEventListener('click', () => {
    deck.reshuffle(); deck.save(); refreshIdle();
    el.sheet.hidden = true; show('idle');
  });

  // ---------- 설정: 자이로 ----------
  flip.onFlip(async () => {
    el.flipPrompt.hidden = true;
    try { await player.playFrom(prefs.startAt); }
    catch (err) { console.warn('엎기 재생 실패:', err); }
  });

  function syncGyroNote() {
    if (!FlipDetector.supported) {
      el.optGyro.checked = false;
      el.optGyro.disabled = true;
      el.gyroNote.textContent = window.isSecureContext
        ? '이 기기에서는 동작 센서를 쓸 수 없습니다.'
        : '동작 센서는 HTTPS 주소에서만 동작합니다.';
      return;
    }
    el.optGyro.disabled = false;
    el.gyroNote.textContent = prefs.gyro ? '시작을 누른 뒤 폰을 엎으면 재생됩니다.' : '';
  }

  el.optGyro.addEventListener('change', async () => {
    if (el.optGyro.checked && !(await FlipDetector.requestPermission())) {
      el.optGyro.checked = false;
      el.gyroNote.textContent = '동작 센서 권한이 거부되었습니다.';
      return;
    }
    prefs.gyro = el.optGyro.checked; savePrefs(); syncGyroNote();
  });

  // ---------- 설정: 게임 모드 ----------
  function applyModeUi() {
    app.dataset.mode = prefs.mode;
    [...el.modeChips.querySelectorAll('.chip')].forEach((c) =>
      c.setAttribute('aria-pressed', String(c.dataset.mode === prefs.mode))
    );
    el.modeNote.textContent = prefs.mode === 'ost'
      ? '영화·드라마의 대표 OST 를 듣고 작품의 출시 연도를 맞힙니다. 작품 제목과 주연 배역 이름도 함께 공개됩니다.'
      : '노래를 듣고 발매 연도를 맞힙니다. 가수와 곡 제목이 함께 공개됩니다.';
  }

  async function setMode(mode) {
    if (mode === prefs.mode) return;
    prefs.mode = mode;
    prefs.from = null; prefs.to = null;   // 모드마다 연대 분포가 달라 필터는 초기화한다
    savePrefs();
    player?.stop();
    currentSong = null;
    await deck.load(mode);
    deck.applyFilter({ from: null, to: null });
    deck.restore();
    applyModeUi();
    buildChips();
    refreshIdle();
    show(deck.isEmpty ? 'done' : 'idle');
  }

  el.modeChips.addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    try {
      await setMode(chip.dataset.mode);
    } catch (err) {
      console.error(err);
      fail(`${Deck.MODES[chip.dataset.mode]?.label ?? chip.dataset.mode} 목록을 불러오지 못했습니다. ${err.message}`);
    }
  });

  // ---------- 설정: 재생 엔진 ----------
  el.engineChips.addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.dataset.engine === prefs.engine) return;
    const name = chip.dataset.engine;

    if (name === 'spotify' && !SpotifyAuth.isLoggedIn) {
      // 로그인 전이면 설정 영역만 펼쳐 보여주고 엔진은 바꾸지 않는다
      el.spotifySetup.hidden = false;
      setSpotifyStatus('아래에서 Client ID 를 입력하고 로그인해 주세요.', 'warn');
      return;
    }
    try {
      if (name === 'spotify') setSpotifyStatus('Spotify 기기에 연결하는 중…');
      await setEngine(name);
      if (name === 'spotify') setSpotifyStatus('Spotify 준비 완료. 원곡 전체가 재생됩니다.', 'ok');
    } catch (err) {
      setSpotifyStatus(err.message, 'warn');
      await setEngine('itunes');
    }
  });

  el.spotifyClient.addEventListener('change', () => {
    const was = SpotifyAuth.isLoggedIn;
    SpotifyAuth.clientId = el.spotifyClient.value;
    if (!el.spotifyClient.value) { setSpotifyStatus(''); return; }
    setSpotifyStatus(was && !SpotifyAuth.isLoggedIn
      ? '앱이 바뀌어 로그아웃했습니다. 새 앱으로 다시 로그인해 주세요.'
      : 'Client ID 저장됨. 로그인해 주세요.');
  });

  el.copyRedirect.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(SpotifyAuth.redirectUri);
      el.copyRedirect.textContent = '복사됨';
      setTimeout(() => { el.copyRedirect.textContent = '복사'; }, 1500);
    } catch (_) {
      setSpotifyStatus('복사에 실패했습니다. 주소를 직접 선택해 복사해 주세요.', 'warn');
    }
  });

  // Spotify 가 안 될 때 원인이 여러 갈래라, 어디서 막혔는지 순서대로 짚어 보여준다.
  el.diagBtn.addEventListener('click', async () => {
    SpotifyAuth.clientId = el.spotifyClient.value || SpotifyAuth.clientId;
    el.diag.hidden = false;
    el.diag.innerHTML = '';
    el.diagBtn.disabled = true;
    el.diagBtn.textContent = '진단 중…';

    const MARK = { ok: '✓', fail: '✕', warn: '!', skip: '·' };
    const add = ({ name, state, detail }) => {
      const li = document.createElement('li');
      li.className = state;
      li.innerHTML = `<span class="mark">${MARK[state]}</span>`
        + `<span class="name"></span><span class="detail"></span>`;
      li.querySelector('.name').textContent = name;
      li.querySelector('.detail').textContent = detail || '';
      el.diag.appendChild(li);
    };
    try {
      // 앱이 이미 연결해 둔 플레이어를 그대로 넘긴다
      await diagnoseSpotify(deck.peek(0) || deck.all[0], add, player);
    } catch (err) {
      add({ name: '진단', state: 'fail', detail: err.message });
    }
    el.diagBtn.disabled = false;
    el.diagBtn.textContent = '연결 진단';
  });

  // Spotify 는 실행 중에 검색해 곡을 찾으므로, 무엇에 붙었는지 미리 볼 수가 없다.
  // 전곡을 훑어 기대한 곡과 실제 매칭을 나란히 보여준다.
  let auditAbort = null;
  let auditLines = [];
  el.auditBtn.addEventListener('click', async () => {
    if (!SpotifyAuth.isLoggedIn) {
      setSpotifyStatus('먼저 Spotify 에 로그인해 주세요.', 'warn');
      return;
    }
    auditAbort = new AbortController();
    el.audit.hidden = false;
    el.auditList.innerHTML = '';
    el.auditBtn.disabled = true;

    const count = { ok: 0, warn: 0, fail: 0 };
    let waiting = null;   // 대기 안내 줄 (한 줄만 유지)
    auditLines = [];
    const render = ({ song, track, state, note, done, total, halted, notice, transient }) => {
      if (notice) {
        // transient 는 대기 상태 표시다. 줄을 쌓지 않고 한 줄을 고쳐 쓴다.
        if (waiting && waiting.parentNode) waiting.remove();
        const li = document.createElement('li');
        li.className = 'warn';
        li.textContent = notice;
        el.auditList.appendChild(li);
        if (transient) { waiting = li; return; }
        waiting = null;
        auditLines.push(`※ ${notice}
`);
        return;
      }
      if (halted) {                        // 중단 안내는 곡이 아니라 알림이다
        el.auditProgress.textContent =
          `${done}/${total}  ·  정상 ${count.ok} · 확인 ${count.warn} · 실패 ${count.fail}  (중단됨)`;
        const li = document.createElement('li');
        li.className = 'fail';
        li.textContent = note;
        el.auditList.appendChild(li);
        auditLines.push(`
※ ${note}`);
        return;
      }
      count[state] += 1;
      if (state !== 'ok') {
        // 그대로 붙여넣어 전달할 수 있도록 텍스트로도 쌓아 둔다
        auditLines.push(
          `[${state === 'fail' ? '실패' : '확인'}] ${song.year} ${song.artist} — ${song.title || song.song}`
          + (track ? `
    → ${track.artists} / ${track.name} [${track.album}]` : '')
          + `
    ${note}`
        );
      }
      el.auditProgress.textContent =
        `${done}/${total}  ·  정상 ${count.ok} · 확인 ${count.warn} · 실패 ${count.fail}`;
      if (state === 'ok') return;          // 문제 있는 것만 남겨 눈에 띄게 한다
      const li = document.createElement('li');
      li.className = state;
      const want = document.createElement('div');
      want.className = 'want';
      want.textContent = `${song.year} ${song.artist} — ${song.title || song.song}`;
      li.appendChild(want);
      if (track) {
        const got = document.createElement('div');
        got.className = 'got';
        got.textContent = `→ ${track.artists} / ${track.name} [${track.album}]`;
        li.appendChild(got);
      }
      const n = document.createElement('div');
      n.className = 'note';
      n.textContent = note;
      li.appendChild(n);
      el.auditList.appendChild(li);
    };

    try {
      await auditSpotifyMatches(deck.all, render, { signal: auditAbort.signal });
      el.auditProgress.textContent += auditAbort.signal.aborted ? '  (중지됨)' : '  (완료)';
    } catch (err) {
      el.auditProgress.textContent = '검사 실패: ' + err.message;
    }
    el.auditBtn.disabled = false;
  });

  el.auditStop.addEventListener('click', () => auditAbort?.abort());

  // 결과를 그대로 옮겨 전달할 수 있게 텍스트로 뽑는다
  // 찾아 둔 Spotify 곡을 파일로 옮기기 위해 꺼낸다. 개발 모드 할당량은
  // 개발자 계정 단위라 다시 찾을 기회가 넉넉하지 않다.
  // 붙여넣기로 주고받으면 주소 한 글자만 틀려도 엉뚱한 곡이 나온다. 파일로 내려받는다.
  el.auditExport.addEventListener('click', () => {
    const data = new SpotifyTrackResolver().export(deck.all);
    if (!data.count) { el.auditExport.textContent = '찾은 곡 없음'; return; }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `spotify-${prefs.mode}-${data.deck.have}of${data.deck.total}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    el.auditExport.textContent = `${data.deck.have}/${data.deck.total}곡 저장됨`;
    setTimeout(() => { el.auditExport.textContent = '찾은 곡 파일로 저장'; }, 3500);
  });

  el.auditCopy.addEventListener('click', async () => {
    if (!auditLines.length) { el.auditCopy.textContent = '결과 없음'; return; }
    const text = [
      `# 곡 매칭 검사 — ${Deck.MODES[prefs.mode].label} (${deck.all.length}곡)` + ` · ${window.RESOLVER_BUILD || '구버전'}`,
      el.auditProgress.textContent.trim(),
      '',
      ...auditLines,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      el.auditCopy.textContent = '복사됨';
      setTimeout(() => { el.auditCopy.textContent = '결과 복사'; }, 1800);
    } catch (_) {
      // 클립보드가 막힌 환경이면 직접 선택해 복사할 수 있게 펼쳐 준다
      el.auditText.value = text;
      el.auditText.hidden = false;
      el.auditText.select();
      el.auditCopy.textContent = '아래에서 직접 복사';
    }
  });

  // Client ID 32자를 다른 기기에서 손으로 치기 번거로워 QR 로 옮긴다.
  el.qrBtn.addEventListener('click', () => {
    const id = (el.spotifyClient.value || SpotifyAuth.clientId).trim();
    if (!id) { setSpotifyStatus('먼저 Client ID 를 입력해 주세요.', 'warn'); return; }
    SpotifyAuth.clientId = id;
    if (!el.qrBox.hidden) { el.qrBox.hidden = true; el.qrBtn.textContent = 'QR로 다른 기기에 옮기기'; return; }
    try {
      QR.render(el.qrCanvas, `${SpotifyAuth.redirectUri}#cid=${encodeURIComponent(id)}`, { scale: 5 });
      el.qrBox.hidden = false;
      el.qrBtn.textContent = 'QR 닫기';
    } catch (err) {
      setSpotifyStatus('QR 생성에 실패했습니다: ' + err.message, 'warn');
    }
  });

  el.spotifyLogin.addEventListener('click', async () => {
    SpotifyAuth.clientId = el.spotifyClient.value;
    try { await SpotifyAuth.beginLogin(); }
    catch (err) { setSpotifyStatus(err.message, 'warn'); }
  });

  el.spotifyLogout.addEventListener('click', async () => {
    SpotifyAuth.logout();
    await setEngine('itunes');
    syncSpotifyUi();
    setSpotifyStatus('로그아웃되었습니다.');
  });

  /**
   * QR 로 넘어온 Client ID 를 주소에서 받아 저장한다.
   * 앱을 이미 열어 둔 상태에서 QR 링크를 타면 해시만 바뀌고 페이지가 다시 뜨지 않으므로
   * hashchange 에서도 같은 처리를 한다.
   */
  function takeClientIdFromHash() {
    const cid = new URLSearchParams(location.hash.slice(1)).get('cid');
    if (!cid) return false;
    SpotifyAuth.clientId = cid;
    history.replaceState({}, '', SpotifyAuth.redirectUri);
    return true;
  }

  window.addEventListener('hashchange', () => {
    if (!takeClientIdFromHash()) return;
    syncSpotifyUi();
    buildChips();
    el.sheet.hidden = false;
    el.spotifySetup.hidden = false;
    setSpotifyStatus('QR 로 Client ID 를 받았습니다. Spotify 로그인만 해주세요.', 'ok');
  });

  function syncSpotifyUi() {
    el.redirectUri.textContent = SpotifyAuth.redirectUri;
    el.spotifyClient.value = SpotifyAuth.clientId;
    el.spotifyLogin.hidden = SpotifyAuth.isLoggedIn;
    el.spotifyLogout.hidden = !SpotifyAuth.isLoggedIn;
  }

  // ---------- 버튼 ----------
  el.start.addEventListener('click', () => startRound());
  el.toggle.addEventListener('click', togglePlay);
  el.reveal.addEventListener('click', revealAnswer);
  el.next.addEventListener('click', nextRound);
  el.reset.addEventListener('click', () => {
    deck.reshuffle(); deck.save(); refreshIdle(); show('idle');
  });
  const replay = () => player.playFrom(prefs.startAt).catch((e) => console.warn(e));
  el.replay.addEventListener('click', replay);
  el.replay2.addEventListener('click', () => { show('playing'); replay(); });
  el.retry.addEventListener('click', () => location.reload());

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || !el.sheet.hidden) return;
    if (app.dataset.screen === 'playing') { e.preventDefault(); togglePlay(); }
    else if (app.dataset.screen === 'idle') { e.preventDefault(); startRound(); }
  });

  // ---------- 시작 ----------
  (async function init() {
    setPlayingFlag(false);

    const fromQr = takeClientIdFromHash();
    syncSpotifyUi();
    if (fromQr) {
      setSpotifyStatus('QR 로 Client ID 를 받았습니다. Spotify 로그인만 해주세요.', 'ok');
    }

    // Spotify 로그인에서 돌아왔다면 먼저 인가 코드를 토큰으로 바꾼다
    let justLoggedIn = false;
    try {
      justLoggedIn = await SpotifyAuth.handleRedirect();
      if (justLoggedIn) { syncSpotifyUi(); prefs.engine = 'spotify'; savePrefs(); }
    } catch (err) {
      setSpotifyStatus(err.message, 'warn');
      prefs.engine = 'itunes'; savePrefs();
    }

    try {
      await deck.load(prefs.mode);
      applyModeUi();
      deck.applyFilter({ from: prefs.from, to: prefs.to });
      deck.restore();

      try {
        await setEngine(prefs.engine);
        if (prefs.engine === 'spotify') {
          setSpotifyStatus('Spotify 준비 완료. 원곡 전체가 재생됩니다.', 'ok');
        }
      } catch (err) {
        setSpotifyStatus(err.message, 'warn');
        await setEngine('itunes');
      }

      el.volume.value = prefs.volume;
      el.optAutoplay.checked = prefs.autoplay;
      el.optKeepAwake.checked = prefs.keepAwake;
      el.optGyro.checked = prefs.gyro;
      syncGyroNote();
      refreshIdle();
      show(deck.isEmpty ? 'done' : 'idle');

      // 로그인 직후에는 결과를 바로 볼 수 있게 설정 시트를 열어 준다
      if (justLoggedIn || fromQr) { buildChips(); el.sheet.hidden = false; el.spotifySetup.hidden = false; }
    } catch (err) {
      console.error(err);
      fail(err.message || '앱을 시작하지 못했습니다');
    }
  })();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
