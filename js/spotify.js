/**
 * Spotify 재생 엔진.
 *
 * iTunes 미리듣기는 애플이 잘라둔 30초가 전부라 '원곡 처음부터'가 불가능하다.
 * Spotify Web Playback SDK 는 브라우저 안에서 풀 트랙을 재생하므로 그 제약이 없다.
 *
 * 전제:
 *   - Spotify Premium (모바일 전용 요금제는 SDK 사용 불가)
 *   - 개발자 대시보드에서 발급한 Client ID
 *   - 대시보드에 이 페이지 주소가 Redirect URI 로 등록되어 있을 것
 *   - 개발 모드에서는 대시보드 사용자 목록에 올라간 계정(최대 5명)만 로그인 가능
 *
 * 인증은 PKCE 를 쓴다. 클라이언트만으로 완결되므로 서버가 필요 없고,
 * Client Secret 을 페이지에 두지 않아도 된다.
 */

const SPOTIFY_AUTH = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API = 'https://api.spotify.com/v1';
const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';

// streaming 은 SDK 재생에, user-read-* 는 SDK 초기화에, user-modify-* 는 play/seek 에 필요하다
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

const KEY_TOKEN = 'music-game/spotify/token/v1';
const KEY_VERIFIER = 'music-game/spotify/verifier/v1';
const KEY_CLIENT = 'music-game/spotify/client-id/v1';
const KEY_URIMAP = 'music-game/spotify/uri-map/v1';

// ---------------------------------------------------------------- PKCE 유틸

function randomString(len = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- 인증

class SpotifyAuth {
  static get clientId() { return localStorage.getItem(KEY_CLIENT) || ''; }
  static set clientId(v) {
    if (v) localStorage.setItem(KEY_CLIENT, v.trim());
    else localStorage.removeItem(KEY_CLIENT);
  }

  /** 대시보드에 등록해야 하는 Redirect URI. 쿼리·해시를 뺀 현재 페이지 주소. */
  static get redirectUri() {
    return location.origin + location.pathname;
  }

  static loadToken() {
    try {
      const t = JSON.parse(localStorage.getItem(KEY_TOKEN) || 'null');
      return t && t.access_token ? t : null;
    } catch (_) { return null; }
  }

  static saveToken(t) {
    t.expires_at = Date.now() + (t.expires_in ?? 3600) * 1000 - 60_000; // 1분 여유
    localStorage.setItem(KEY_TOKEN, JSON.stringify(t));
    return t;
  }

  static logout() {
    localStorage.removeItem(KEY_TOKEN);
    localStorage.removeItem(KEY_VERIFIER);
  }

  static get isLoggedIn() { return !!SpotifyAuth.loadToken(); }

  /** 로그인 페이지로 보낸다. 돌아오면 ?code= 가 붙는다. */
  static async beginLogin() {
    const clientId = SpotifyAuth.clientId;
    if (!clientId) throw new Error('Client ID 를 먼저 입력해 주세요');

    const verifier = randomString();
    localStorage.setItem(KEY_VERIFIER, verifier);

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: SpotifyAuth.redirectUri,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: await sha256Base64Url(verifier),
    });
    location.href = `${SPOTIFY_AUTH}?${params}`;
  }

  /**
   * 로그인에서 돌아왔을 때 ?code= 를 토큰으로 바꾼다.
   * @returns {Promise<boolean>} 이번 로드에서 로그인 처리를 했으면 true
   */
  static async handleRedirect() {
    const url = new URL(location.href);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      cleanUrl();
      throw new Error(`Spotify 로그인이 거부되었습니다 (${error})`);
    }
    if (!code) return false;

    const verifier = localStorage.getItem(KEY_VERIFIER);
    if (!verifier) { cleanUrl(); throw new Error('로그인 정보가 유실되었습니다. 다시 시도해 주세요'); }

    const res = await fetch(SPOTIFY_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SpotifyAuth.clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: SpotifyAuth.redirectUri,
        code_verifier: verifier,
      }),
    });
    cleanUrl();
    localStorage.removeItem(KEY_VERIFIER);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`토큰 발급 실패 (${res.status}). Redirect URI 가 대시보드 설정과 정확히 같은지 확인해 주세요. ${body.slice(0, 160)}`);
    }
    SpotifyAuth.saveToken(await res.json());
    return true;

    function cleanUrl() {
      // 주소창에 code 가 남으면 새로고침 때 재사용되어 실패한다
      history.replaceState({}, '', SpotifyAuth.redirectUri);
    }
  }

  /** 유효한 액세스 토큰. 만료되었으면 갱신한다. */
  static async getAccessToken() {
    let t = SpotifyAuth.loadToken();
    if (!t) throw new Error('Spotify 에 로그인되어 있지 않습니다');
    if (Date.now() < t.expires_at) return t.access_token;

    if (!t.refresh_token) { SpotifyAuth.logout(); throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요'); }

    const res = await fetch(SPOTIFY_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SpotifyAuth.clientId,
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
      }),
    });
    if (!res.ok) { SpotifyAuth.logout(); throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요'); }

    const fresh = await res.json();
    // 갱신 응답에 refresh_token 이 빠질 수 있어 기존 값을 살려둔다
    SpotifyAuth.saveToken({ refresh_token: t.refresh_token, ...fresh });
    return fresh.access_token;
  }

  /** 인증 헤더가 붙은 fetch. 401 이면 한 번 갱신해 재시도한다. */
  static async api(path, options = {}, retry = true) {
    const token = await SpotifyAuth.getAccessToken();
    const res = await fetch(path.startsWith('http') ? path : SPOTIFY_API + path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
    if (res.status === 401 && retry) {
      const t = SpotifyAuth.loadToken();
      if (t) { t.expires_at = 0; localStorage.setItem(KEY_TOKEN, JSON.stringify(t)); }
      return SpotifyAuth.api(path, options, false);
    }
    return res;
  }
}

// ---------------------------------------------------------------- 트랙 매칭

/**
 * 곡 데이터에는 Spotify URI 가 비어 있으므로 검색으로 찾아 채운다.
 * 한 번 찾은 결과는 저장해 두어 매번 검색하지 않는다.
 */
class SpotifyTrackResolver {
  constructor() {
    try { this.map = JSON.parse(localStorage.getItem(KEY_URIMAP) || '{}'); }
    catch (_) { this.map = {}; }
  }

  _save() {
    try { localStorage.setItem(KEY_URIMAP, JSON.stringify(this.map)); } catch (_) {}
  }

  static _norm(s) {
    // 악센트만 떼고 한글 음절은 다시 합친다. NFD 로 쪼갠 채 두면 아래 [가-힣] 필터가
    // 자모를 전부 걸러 한글이 통째로 사라진다.
    let out = (s || '').toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').normalize('NFC');
    return out.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '')
              .replace(/[^0-9a-z가-힣ぁ-ゖァ-ヺ一-龯]/g, '');
  }

  /** 곡 제목. K-POP 은 title, OST 는 song 에 들어 있다. */
  static _title(song) { return song.title || song.song || ''; }

  /**
   * 연주곡인가. 가사가 없어 듣고 맞힐 수가 없으므로 아예 쓰지 않는다.
   * 라이브·리믹스와 달리 '차선책'조차 되지 못한다.
   */
  static _isInstrumental(track) {
    const blob = `${track.name} ${track.album?.name || ''}`;
    return /(?<![a-z])(instrumental|inst|karaoke|mr\s*ver|backing\s*track)(?![a-z])/i.test(blob)
        || /(?<![가-힣])(반주|연주곡)(?![가-힣])/.test(blob);
  }

  /**
   * 원곡과 소리가 다른 버전인가. 원곡이 있으면 그쪽이 이기고,
   * 없으면 차선으로 쓴다 — 라이브라도 알아들을 수는 있기 때문이다.
   */
  static _isVariant(track) {
    const blob = `${track.name} ${track.album?.name || ''}`;
    return /(?<![a-z])(live|remix|acoustic|cover|ver\.|version|edit)(?![a-z])/i.test(blob)
        || /(?<![가-힣])(라이브|리믹스|어쿠스틱|재녹음)(?![가-힣])/.test(blob);
  }

  static _score(track, song) {
    const t = SpotifyTrackResolver._norm(track.name);
    const want = SpotifyTrackResolver._norm(SpotifyTrackResolver._title(song));
    if (!want) return -99;

    // 가수가 다르면 제목이 같아도 다른 곡이다. iTunes 쪽에서 '폼생폼사'가 동명이곡으로
    // 잡혔던 사고와 같은 유형이라 여기서도 필수 조건으로 둔다.
    const artists = track.artists.map((a) => SpotifyTrackResolver._norm(a.name)).join('');
    const wantArtist = SpotifyTrackResolver._norm(song.artist);
    const artistOk = artists && wantArtist &&
      (artists.includes(wantArtist) || wantArtist.includes(artists));

    let s = 0;
    if (t === want) s += 5;                                   // 정확히 같으면 강한 신호
    else if (t.includes(want) || want.includes(t)) s += 2;
    else return -50;                                          // 제목이 아예 다르면 탈락
    if (!artistOk) return -50;

    if (SpotifyTrackResolver._isInstrumental(track)) return -50;
    if (SpotifyTrackResolver._isVariant(track)) s -= 4;

    // 연도는 K-POP 에서만 본다. OST 의 year 는 '작품의 방영 연도'라 곡 발매일과 무관하다.
    if (!song.work) {
      const year = parseInt((track.album?.release_date || '').slice(0, 4), 10);
      if (year === song.year) s += 1.5;
      else if (Math.abs(year - song.year) <= 1) s += 0.7;
    }

    s += (track.popularity || 0) / 200;   // 동점이면 널리 알려진 쪽
    return s;
  }

  async resolve(song) {
    if (song.spotifyUri) return song.spotifyUri;
    if (this.map[song.id]) return this.map[song.id];

    const title = SpotifyTrackResolver._title(song);
    const label = `${song.artist} - ${title}`;
    // 한국어 곡명이 많아 필드 한정 검색보다 자유 질의가 더 잘 맞는다
    const q = encodeURIComponent(`${song.artist} ${title}`);
    const res = await SpotifyAuth.api(`/search?q=${q}&type=track&limit=10&market=KR`);
    if (!res.ok) throw new Error(`Spotify 검색 실패 (${res.status})`);

    const items = (await res.json()).tracks?.items || [];
    const scored = items
      .map((t) => ({ t, s: SpotifyTrackResolver._score(t, song) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    if (!scored.length) {
      throw new Error(`Spotify 에서 이 곡을 찾지 못했습니다: ${label}`);
    }

    this.map[song.id] = scored[0].t.uri;
    this._save();
    return scored[0].t.uri;
  }
}

// ---------------------------------------------------------------- 재생기

class SpotifyProvider extends AudioProvider {
  constructor() {
    super();
    this.player = null;
    this.deviceId = null;
    this.resolver = new SpotifyTrackResolver();
    this._duration = 0;
    this._position = 0;
    this._playing = false;
    this._ticker = null;
    this._lastSync = 0;
  }

  static get available() { return SpotifyAuth.isLoggedIn; }

  /** SDK 스크립트를 한 번만 읽어들인다. */
  static _loadSdk() {
    if (SpotifyProvider._sdkPromise) return SpotifyProvider._sdkPromise;
    SpotifyProvider._sdkPromise = new Promise((resolve, reject) => {
      if (window.Spotify) return resolve();
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      const s = document.createElement('script');
      s.src = SDK_SRC;
      s.async = true;
      s.onerror = () => reject(new Error('Spotify SDK 를 불러오지 못했습니다'));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error('Spotify SDK 응답이 없습니다')), 15000);
    });
    return SpotifyProvider._sdkPromise;
  }

  async connect() {
    if (this.deviceId) return this.deviceId;
    await SpotifyProvider._loadSdk();

    this.player = new window.Spotify.Player({
      name: '노래 맞히기',
      getOAuthToken: (cb) => { SpotifyAuth.getAccessToken().then(cb).catch(() => {}); },
      volume: 0.85,
    });

    this.player.addListener('initialization_error', ({ message }) =>
      this._emit('error', new Error(`초기화 실패: ${message}`)));
    this.player.addListener('authentication_error', ({ message }) => {
      SpotifyAuth.logout();
      this._emit('error', new Error(`인증 실패: ${message}. 다시 로그인해 주세요.`));
    });
    this.player.addListener('account_error', () =>
      this._emit('error', new Error('Spotify Premium 계정이 필요합니다 (모바일 전용 요금제는 사용할 수 없습니다).')));
    this.player.addListener('playback_error', ({ message }) =>
      this._emit('error', new Error(`재생 오류: ${message}`)));

    this.player.addListener('player_state_changed', (state) => {
      if (!state) return;
      this._duration = state.duration / 1000;
      this._position = state.position / 1000;
      this._lastSync = performance.now();

      const wasPlaying = this._playing;
      this._playing = !state.paused;
      if (wasPlaying !== this._playing) this._emit(this._playing ? 'play' : 'pause');

      // SDK 는 곡이 끝나면 position 0 에서 멈춘 상태를 알린다
      if (state.paused && state.position === 0 && wasPlaying) this._emit('ended');
    });

    const ready = new Promise((resolve, reject) => {
      this.player.addListener('ready', ({ device_id }) => { this.deviceId = device_id; resolve(device_id); });
      this.player.addListener('not_ready', () => { this.deviceId = null; });
      setTimeout(() => reject(new Error('Spotify 기기 연결이 지연됩니다. 새로고침 후 다시 시도해 주세요.')), 20000);
    });

    const ok = await this.player.connect();
    if (!ok) throw new Error('Spotify 플레이어 연결에 실패했습니다');
    await ready;
    this._startTicker();
    return this.deviceId;
  }

  /** SDK 는 상태 변화 때만 알려주므로, 그 사이 진행 시간은 직접 굴린다. */
  _startTicker() {
    clearInterval(this._ticker);
    this._ticker = setInterval(() => {
      if (!this._playing) return;
      const now = performance.now();
      this._position += (now - this._lastSync) / 1000;
      this._lastSync = now;
      this._emit('timeupdate', { current: this._position, duration: this._duration });
    }, 250);
  }

  /**
   * 곡을 준비한다. Spotify 는 '로드'와 '재생'이 분리되어 있지 않아
   * 실제 재생은 play() 에서 시작한다.
   */
  async load(song) {
    await this.connect();
    this._uri = await this.resolver.resolve(song);
    this._position = 0;
    this._duration = 0;
    this._started = false;
    this._emit('ready');
  }

  /** 지정 지점부터 새로 재생. 이 기기로 재생을 넘기면서 시작 위치를 함께 보낸다. */
  async playFrom(startSeconds = 0) {
    if (!this._uri) throw new Error('재생할 곡이 지정되지 않았습니다');

    const res = await SpotifyAuth.api(`/me/player/play?device_id=${this.deviceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uris: [this._uri],
        position_ms: Math.max(0, Math.round(startSeconds * 1000)),
      }),
    });
    if (!res.ok && res.status !== 204) {
      const detail = await res.text().catch(() => '');
      if (res.status === 403) {
        throw new Error('재생이 거부되었습니다. Spotify Premium 계정인지 확인해 주세요.');
      }
      throw new Error(`재생을 시작하지 못했습니다 (${res.status}) ${detail.slice(0, 120)}`);
    }
    this._started = true;
    this._playing = true;
    this._lastSync = performance.now();
    this._position = startSeconds;
  }

  /** 현재 위치에서 이어서 재생 */
  async play() {
    if (!this._started) return this.playFrom(0);
    await this.player.resume();
  }

  pause() { this.player?.pause().catch(() => {}); }

  stop() {
    this.player?.pause().catch(() => {});
    this._started = false;
    this._playing = false;
    this._position = 0;
  }

  get duration() { return this._duration; }
  get currentTime() { return this._position; }
  get isPlaying() { return this._playing; }

  seek(seconds) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    this.player?.seek(ms).catch(() => {});
    this._position = seconds;
    this._lastSync = performance.now();
  }

  set volume(v) { this.player?.setVolume(Math.max(0, Math.min(1, v))).catch(() => {}); }

  destroy() {
    clearInterval(this._ticker);
    this.player?.disconnect();
    this.player = null;
    this.deviceId = null;
    this._handlers = {};
  }
}

window.SpotifyAuth = SpotifyAuth;
window.SpotifyProvider = SpotifyProvider;
window.SpotifyTrackResolver = SpotifyTrackResolver;
