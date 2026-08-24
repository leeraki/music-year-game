/**
 * 재생 엔진 추상화.
 *
 * 게임 로직은 AudioProvider 인터페이스에만 의존한다.
 * 지금은 iTunes 30초 미리듣기를 쓰지만, 같은 인터페이스로 Spotify Web Playback SDK
 * 구현체를 추가하면 게임 코드를 건드리지 않고 엔진을 교체할 수 있다.
 */

/** 구현체가 지켜야 할 계약. */
class AudioProvider {
  /** @param {object} song songs.json 의 레코드 */
  async load(song) { throw new Error('구현 필요'); }
  async play() { throw new Error('구현 필요'); }
  pause() { throw new Error('구현 필요'); }
  stop() { throw new Error('구현 필요'); }
  /** @returns {number} 초 */
  get duration() { return 0; }
  get currentTime() { return 0; }
  get isPlaying() { return false; }
  seek(seconds) {}
  destroy() {}

  constructor() {
    this._handlers = {};
  }
  on(event, fn) {
    (this._handlers[event] ||= []).push(fn);
    return this;
  }
  _emit(event, payload) {
    (this._handlers[event] || []).forEach((fn) => fn(payload));
  }
}

/**
 * iTunes 30초 미리듣기 재생기.
 *
 * 오디오를 이 페이지가 직접 재생하므로 잠금화면·알림에 무엇이 뜰지 전적으로 우리가 정한다.
 * 곡 제목이 새어나가지 않도록 미디어 세션 메타데이터를 중립값으로 덮어쓴다.
 */
class ItunesPreviewProvider extends AudioProvider {
  constructor() {
    super();
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    this.el = el;

    el.addEventListener('canplay', () => this._emit('ready'));
    el.addEventListener('play', () => this._emit('play'));
    el.addEventListener('pause', () => this._emit('pause'));
    el.addEventListener('ended', () => this._emit('ended'));
    el.addEventListener('timeupdate', () =>
      this._emit('timeupdate', { current: el.currentTime, duration: el.duration || 0 })
    );
    el.addEventListener('error', () =>
      this._emit('error', new Error('오디오를 불러오지 못했습니다'))
    );

    this._maskMediaSession();
  }

  /** 잠금화면·알림창에 곡 정보가 노출되지 않도록 중립 메타데이터로 고정한다. */
  _maskMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: '???',
        artist: '노래 맞히기',
        album: '',
      });
    } catch (_) {
      /* 미지원 브라우저는 무시 */
    }
  }

  async load(song) {
    if (!song?.previewUrl) throw new Error('재생할 미리듣기 주소가 없습니다');
    this.el.src = song.previewUrl;
    this.el.load();
    this._maskMediaSession();
    return new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const ng = () => { cleanup(); reject(new Error('오디오 로드 실패')); };
      const cleanup = () => {
        this.el.removeEventListener('canplay', ok);
        this.el.removeEventListener('error', ng);
      };
      this.el.addEventListener('canplay', ok, { once: true });
      this.el.addEventListener('error', ng, { once: true });
    });
  }

  async play() {
    this._maskMediaSession();
    await this.el.play();
  }
  pause() { this.el.pause(); }
  stop() { this.el.pause(); this.el.currentTime = 0; }

  get duration() { return this.el.duration || 0; }
  get currentTime() { return this.el.currentTime || 0; }
  get isPlaying() { return !this.el.paused && !this.el.ended; }

  seek(seconds) {
    if (Number.isFinite(this.el.duration)) {
      this.el.currentTime = Math.max(0, Math.min(seconds, this.el.duration));
    }
  }

  set volume(v) { this.el.volume = Math.max(0, Math.min(1, v)); }
  get volume() { return this.el.volume; }

  destroy() {
    this.stop();
    this.el.src = '';
    this._handlers = {};
  }
}

/**
 * 다음 곡 오디오를 미리 받아두어 '시작' 직후의 공백을 없앤다.
 * 파티 진행 중 곡 사이가 끊기면 흐름이 깨지므로 중요하다.
 */
class Prefetcher {
  constructor() { this.cache = new Map(); }

  warm(song) {
    if (!song?.previewUrl || this.cache.has(song.id)) return;
    const a = new Audio();
    a.preload = 'auto';
    a.src = song.previewUrl;
    this.cache.set(song.id, a);
    if (this.cache.size > 6) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }
}

window.AudioProvider = AudioProvider;
window.ItunesPreviewProvider = ItunesPreviewProvider;
window.Prefetcher = Prefetcher;
