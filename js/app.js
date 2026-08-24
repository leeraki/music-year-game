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
  };

  const PREFS_KEY = 'music-game/prefs/v1';
  const DEFAULTS = {
    volume: 85, autoplay: true, keepAwake: true,
    from: null, to: null, startAt: 0, gyro: false, engine: 'itunes',
  };
  // iTunes 는 30초 클립이라 시작 위치를 길게 줄 수 없다. Spotify 는 풀 트랙이라 여유가 있다.
  const START_MAX = { itunes: 15, spotify: 90 };

  const deck = new Deck();
  const flip = new FlipDetector();
  const prefetcher = new Prefetcher();

  let player = null;
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
    if (player) { try { player.stop(); player.destroy?.(); } catch (_) {} player = null; }

    if (name === 'spotify') {
      if (typeof SpotifyProvider === 'undefined' || !SpotifyAuth.isLoggedIn) {
        throw new Error('Spotify 로그인이 필요합니다');
      }
      const sp = wirePlayer(new SpotifyProvider());
      await sp.connect();          // Premium 아님 / 기기 연결 실패가 여기서 걸린다
      player = sp;
    } else {
      player = wirePlayer(new ItunesPreviewProvider());
    }

    prefs.engine = name;
    savePrefs();
    player.volume = prefs.volume / 100;
    applyEngineUi();
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

    show('playing');
    setPlayingFlag(false);
    el.progressFill.style.width = '0%';
    el.timeCurrent.textContent = '0:00';
    el.timeTotal.textContent = prefs.engine === 'spotify' ? '--:--' : '0:30';
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
      console.warn('재생 실패:', song.artist, '-', song.title, err);
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

  function revealAnswer() {
    if (!currentSong) return;
    player.pause();
    const s = currentSong;
    el.year.textContent = s.year;
    el.artist.textContent = s.artist;
    el.title.textContent = s.title;
    el.title.className = 'reveal-title' +
      (s.title.length > 22 ? ' is-very-long' : s.title.length > 13 ? ' is-long' : '');
    el.album.textContent = s.album || '';
    if (s.artwork) { el.art.src = s.artwork; el.art.alt = `${s.artist} - ${s.title} 앨범 이미지`; }
    else { el.art.removeAttribute('src'); el.art.alt = ''; }
    show('reveal');
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
  const DECADES = [1980, 1990, 2000, 2010, 2020];

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
    DECADES.forEach((d) => mk(`${d}년대`, d, d + 9, deck.countInRange(d, d + 9)));
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
    player.volume = prefs.volume / 100;
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
    SpotifyAuth.clientId = el.spotifyClient.value;
    setSpotifyStatus(el.spotifyClient.value ? 'Client ID 저장됨. 로그인해 주세요.' : '');
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
    syncSpotifyUi();

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
      await deck.load();
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
      if (justLoggedIn) { buildChips(); el.sheet.hidden = false; }
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
