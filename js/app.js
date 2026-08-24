/**
 * 화면 흐름과 게임 진행.
 *
 *   대기(idle) ──시작──> 재생(playing) ──결과 확인──> 공개(reveal) ──다음 곡──> 대기
 *
 * 재생 화면에서는 곡 정보를 어떤 형태로도 노출하지 않는다. 이 게임의 전제이기 때문에
 * 앨범아트/제목은 공개 화면으로 넘어가기 전까지 DOM 에 넣지 않는다.
 */

(() => {
  'use strict';

  const app = document.getElementById('app');
  const $ = (id) => document.getElementById(id);

  const el = {
    remaining: $('deck-remaining'),
    range: $('deck-range'),
    start: $('btn-start'),
    toggle: $('btn-toggle'),
    toggleCaption: $('toggle-caption'),
    reveal: $('btn-reveal'),
    replay: $('btn-replay'),
    replay2: $('btn-replay-2'),
    next: $('btn-next'),
    reset: $('btn-reset'),
    retry: $('btn-retry'),
    progress: $('progress'),
    progressFill: $('progress-fill'),
    timeCurrent: $('time-current'),
    timeTotal: $('time-total'),
    art: $('reveal-art'),
    year: $('reveal-year'),
    artist: $('reveal-artist'),
    title: $('reveal-title'),
    album: $('reveal-album'),
    errorMessage: $('error-message'),
    doneCount: $('done-count'),
    settings: $('btn-settings'),
    sheet: $('sheet'),
    chips: $('decade-chips'),
    filterCount: $('filter-count'),
    volume: $('volume'),
    startAt: $('startat'),
    startAtValue: $('startat-value'),
    optAutoplay: $('opt-autoplay'),
    optKeepAwake: $('opt-keepawake'),
    optGyro: $('opt-gyro'),
    gyroNote: $('gyro-note'),
    flipPrompt: $('flip-prompt'),
    reshuffle: $('btn-reshuffle'),
  };

  const PREFS_KEY = 'music-game/prefs/v1';
  const deck = new Deck();
  const player = new ItunesPreviewProvider();
  const prefetcher = new Prefetcher();
  const flip = new FlipDetector();

  let currentSong = null;
  let wakeLock = null;
  let prefs = loadPrefs();

  // ---------- 설정 저장 ----------
  function loadPrefs() {
    try {
      return Object.assign(
        { volume: 85, autoplay: true, keepAwake: true, from: null, to: null, startAt: 0, gyro: false },
        JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
      );
    } catch (_) {
      return { volume: 85, autoplay: true, keepAwake: true, from: null, to: null, startAt: 0, gyro: false };
    }
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
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function refreshIdle() {
    el.remaining.textContent = deck.remaining;
    const { from, to } = deck.filter;
    el.range.textContent = from || to
      ? `${from ?? '처음'} – ${to ?? '현재'}`
      : `전체 ${deck.total}곡 중`;
  }

  // ---------- 화면 꺼짐 방지 ----------
  async function requestWakeLock() {
    if (!prefs.keepAwake || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) { /* 지원하지 않거나 거부되면 그냥 넘어간다 */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.dataset.screen === 'playing') {
      requestWakeLock();
    }
  });

  // ---------- 게임 진행 ----------
  async function startRound() {
    const song = deck.draw();
    if (!song) { showDone(); return; }
    currentSong = song;

    show('playing');
    setPlayingFlag(false);
    el.progressFill.style.width = '0%';
    el.timeCurrent.textContent = '0:00';
    el.timeTotal.textContent = '0:30';
    requestWakeLock();

    try {
      await player.load(song);
      el.timeTotal.textContent = fmt(player.duration);
      // 클립 길이보다 시작 위치가 크면 의미가 없으므로 여유를 남기고 자른다
      if (prefs.startAt > 0) {
        player.seek(Math.min(prefs.startAt, Math.max(0, player.duration - 5)));
      }
      if (prefs.gyro) {
        // 엎어놓는 순간 재생한다. 화면이 바닥을 보게 되니 정답이 새어나갈 곳이 없다.
        el.flipPrompt.hidden = false;
        flip.start();
      } else if (prefs.autoplay) {
        await player.play();
      }
    } catch (err) {
      // 재생에 실패한 곡은 덱에 돌려놓지 않는다. 같은 곡에서 계속 막히기 때문이다.
      console.warn('재생 실패, 다음 곡으로 넘어갑니다:', song.artist, song.title, err);
      if (deck.remaining > 0) { startRound(); return; }
      fail('이 곡을 재생할 수 없습니다. 네트워크 상태를 확인해 주세요.');
      return;
    }

    prefetcher.warm(deck.peek(0));
    prefetcher.warm(deck.peek(1));
  }

  async function togglePlay() {
    try {
      if (player.isPlaying) player.pause();
      else await player.play();
    } catch (err) {
      console.warn('재생 토글 실패:', err);
    }
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
    el.album.textContent = s.album ? `${s.album}` : '';
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
    player.stop();
    el.doneCount.textContent = `${deck.total}곡을 모두 사용했습니다`;
    show('done');
  }

  function fail(message) {
    el.errorMessage.textContent = message;
    show('error');
  }

  // ---------- 진행바 ----------
  player.on('timeupdate', ({ current, duration }) => {
    const pct = duration ? (current / duration) * 100 : 0;
    el.progressFill.style.width = `${pct}%`;
    el.timeCurrent.textContent = fmt(current);
    if (duration) el.timeTotal.textContent = fmt(duration);
  });
  player.on('play', () => setPlayingFlag(true));
  player.on('pause', () => setPlayingFlag(false));
  player.on('ended', () => { setPlayingFlag(false); el.progressFill.style.width = '100%'; });

  el.progress.addEventListener('click', (e) => {
    const rect = el.progress.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    player.seek(ratio * player.duration);
  });

  // ---------- 설정 시트 ----------
  const DECADES = [1980, 1990, 2000, 2010, 2020];

  function buildChips() {
    el.chips.innerHTML = '';
    const mk = (label, from, to, count) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.innerHTML = `${label}<span class="chip-count">${count}</span>`;
      const active = deck.filter.from === from && deck.filter.to === to;
      b.setAttribute('aria-pressed', String(active));
      // 해당 연대에 곡이 없으면 눌러도 게임이 안 되므로 막아둔다.
      // 숨기지 않고 비활성으로 남겨야 '왜 안 보이지'를 겪지 않는다.
      if (count === 0) {
        b.disabled = true;
        b.title = '이 연대에 곡이 아직 없습니다';
      } else {
        b.addEventListener('click', () => {
          prefs.from = from; prefs.to = to; savePrefs();
          deck.applyFilter({ from, to });
          buildChips();
          refreshIdle();
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

  function openSheet() { buildChips(); el.sheet.hidden = false; }
  function closeSheet() { el.sheet.hidden = true; }

  el.settings.addEventListener('click', openSheet);
  el.sheet.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) closeSheet();
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
  flip.onFlip(async () => {
    el.flipPrompt.hidden = true;
    try { await player.play(); } catch (err) { console.warn('엎기 재생 실패:', err); }
  });

  function syncGyroNote() {
    if (!FlipDetector.supported) {
      el.optGyro.checked = false;
      el.optGyro.disabled = true;
      el.gyroNote.textContent =
        window.isSecureContext
          ? '이 기기에서는 동작 센서를 쓸 수 없습니다.'
          : '동작 센서는 HTTPS 주소에서만 동작합니다. 배포 후 사용할 수 있습니다.';
      return;
    }
    el.optGyro.disabled = false;
    el.gyroNote.textContent = prefs.gyro
      ? '시작을 누른 뒤 폰을 엎으면 재생됩니다.'
      : '';
  }

  el.optGyro.addEventListener('change', async () => {
    if (el.optGyro.checked) {
      // iOS 는 사용자가 직접 누른 순간에만 센서 권한을 물을 수 있다
      const ok = await FlipDetector.requestPermission();
      if (!ok) {
        el.optGyro.checked = false;
        el.gyroNote.textContent = '동작 센서 권한이 거부되었습니다.';
        return;
      }
    }
    prefs.gyro = el.optGyro.checked;
    savePrefs();
    syncGyroNote();
  });

  el.optKeepAwake.addEventListener('change', () => {
    prefs.keepAwake = el.optKeepAwake.checked; savePrefs();
    if (!prefs.keepAwake) releaseWakeLock();
  });
  el.reshuffle.addEventListener('click', () => {
    deck.reshuffle(); deck.save();
    refreshIdle(); closeSheet(); show('idle');
  });

  // ---------- 버튼 배선 ----------
  el.start.addEventListener('click', startRound);
  el.toggle.addEventListener('click', togglePlay);
  el.reveal.addEventListener('click', revealAnswer);
  el.next.addEventListener('click', nextRound);
  el.reset.addEventListener('click', () => {
    deck.reshuffle(); deck.save(); refreshIdle(); show('idle');
  });
  const replay = async () => { player.seek(prefs.startAt || 0); await player.play(); };
  el.replay.addEventListener('click', replay);
  el.replay2.addEventListener('click', async () => { show('playing'); await replay(); });
  el.retry.addEventListener('click', () => location.reload());

  // 스페이스바로 재생/정지 — 데스크톱에서 확인할 때 편하다
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || el.sheet.hidden === false) return;
    if (app.dataset.screen === 'playing') { e.preventDefault(); togglePlay(); }
    else if (app.dataset.screen === 'idle') { e.preventDefault(); startRound(); }
  });

  // ---------- 시작 ----------
  (async function init() {
    setPlayingFlag(false);
    try {
      await deck.load();
      deck.applyFilter({ from: prefs.from, to: prefs.to });
      deck.restore();
      player.volume = prefs.volume / 100;
      el.volume.value = prefs.volume;
      el.startAt.value = prefs.startAt;
      el.startAtValue.textContent = `${prefs.startAt}초`;
      el.optAutoplay.checked = prefs.autoplay;
      el.optKeepAwake.checked = prefs.keepAwake;
      el.optGyro.checked = prefs.gyro;
      syncGyroNote();
      refreshIdle();
      show(deck.isEmpty ? 'done' : 'idle');
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
