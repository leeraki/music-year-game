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
// 검사 결과에 찍어 둔다. 고친 코드가 실제로 돌았는지 결과만 보고 알 수 있어야 한다.
const RESOLVER_BUILD = 'r29-ostquery';
// 찾아 둔 곡을 버릴지 판단하는 기준. 곡을 고르는 규칙이 바뀔 때만 올린다.
// 판번호에 묶었더니 요청 제한 대응처럼 매칭과 무관한 수정에도 230곡을 다시
// 찾게 되어, 그러느라 제한을 또 소진했다.
const MATCH_RULES = 'm5-djmix';
// 검색·조회 요청 사이의 최소 간격. 분당 60건 남짓으로, 개발 모드 한도에
// 닿지 않는 속도다. 검사 한 번이 조금 느려지는 대신 앱이 잠기지 않는다.
const REQUEST_GAP = 2000;
// 로마자 표기가 얼마나 닮아야 같은 사람으로 볼지. 검사에 나온 실제 쌍으로 정했다.
const ROMAN_MATCH = 0.72;

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

// Spotify 는 한국 가수를 영문명으로 올려 두는 일이 많다. 글자로는 안 이어지므로 대조표를 둔다.
const ARTIST_ALIASES = {
  '아이유': ['iu'], '방탄소년단': ['bts'], '소녀시대': ["girls' generation", 'snsd'],
  '빅뱅': ['bigbang', 'big bang'], '블랙핑크': ['blackpink'], '엑소': ['exo'],
  '트와이스': ['twice'], '레드벨벳': ['red velvet'], '에스파': ['aespa'],
  '아이브': ['ive'], '뉴진스': ['newjeans'], '르세라핌': ['le sserafim'],
  '세븐틴': ['seventeen'], '스트레이 키즈': ['stray kids'], '엔하이픈': ['enhypen'],
  '투모로우바이투게더': ['tomorrow x together', 'txt'], '있지': ['itzy'],
  '샤이니': ['shinee'], '슈퍼주니어': ['super junior'], '동방신기': ['tvxq'],
  '원더걸스': ['wonder girls'], '카라': ['kara'], '티아라': ['t-ara'],
  '씨스타': ['sistar'], '에이핑크': ['apink'], '여자친구': ['gfriend'],
  '인피니트': ['infinite'], '비스트': ['beast', 'highlight'], '2ne1': ['투애니원'],
  '미쓰에이': ['miss a'], '오마이걸': ['oh my girl'], '아이즈원': ['iz*one'],
  '모모랜드': ['momoland'], '마마무': ['mamamoo'], '화사': ['hwasa'],
  '태연': ['taeyeon'], '제니': ['jennie'], '지코': ['zico'], '태양': ['taeyang'],
  '싸이': ['psy'], '보아': ['boa'], '비': ['rain'], '선미': ['sunmi'],
  '악동뮤지션': ['akmu', '악뮤'], '악뮤': ['akmu', '악동뮤지션'],
  '자이언티': ['zion.t'], '크러쉬': ['crush'], '딘': ['dean'], '헤이즈': ['heize'],
  '폴킴': ['paul kim'], '벤': ['ben'], '거미': ['gummy'], '에일리': ['ailee'],
  '백예린': ['yerin baek'], '볼빨간사춘기': ['bol4', 'bolbbalgan4'],
  '잔나비': ['jannabi'], '버스커버스커': ['busker busker'], '십센치': ['10cm'],
  '아이들': ['(g)i-dle', 'i-dle'], '엔믹스': ['nmixx'], '아일릿': ['illit'],
  '투어스': ['tws'], '라이즈': ['riize'], '베이비몬스터': ['babymonster'],
  '키키': ['kiiikiii'], '코르티스': ['cortis'], '리센느': ['rescene'],
  '데이식스': ['day6'], '트레저': ['treasure'], '에이티즈': ['ateez'],
  '키스오브라이프': ['kiss of life'], '우즈': ['woodz'], '텐': ['ten'],
  '젝스키스': ['sechskies'], '지오디': ['god'], 'god': ['지오디'],
  '핑클': ['fin.k.l'], 's.e.s.': ['ses'], 'h.o.t.': ['hot'],
  '서태지와 아이들': ['seo taiji and boys'], '신화': ['shinhwa'],
  '플레이브': ['plave'], '피프티피프티': ['fifty fifty'], '큐더블유이알': ['qwer'],
  '헌트릭스': ['huntr/x'], '아이오아이': ['i.o.i', 'ioi'],
  '공일오비': ['015b'], '워너원': ['wanna one'], '이선희': ['lee sun-hee', 'lee sunhee'],
  '김완선': ['kim wan-sun', 'kim wansun'], '조용필': ['cho yong-pil'],
  '이문세': ['lee moon-sae'], '나훈아': ['na hoon-a'], '심수봉': ['sim su-bong'],
  // 뜻을 옮긴 이름은 소리로 견줘도 안 맞는다. 푸른하늘은 'Blue Sky' 로 올라와 있다.
  '푸른하늘': ['blue sky'], '동물원': ['zoo'], '들국화': ['deulgukhwa', 'wild chrysanthemum'],
  '해바라기': ['sunflower', 'haebaragi'], '산울림': ['sanullim', 'sanulrim', 'echo'],
  '무한궤도': ['muhan gwedo', 'infinite track'],
  '보이넥스트도어': ['boynextdoor'], '멜로망스': ['melomance'],
  '이가은': ['페이지', 'page'],   // 「이별이 오지 못하게」 는 페이지라는 이름으로 냈다
  '하은 & 한빈': ['하은', '한빈', '포맨'],
  '불꽃심장': ['flame heart'], '민경훈': ['min kyung hoon'],
  // OST 검사에서 확인된 표기
  '이수영': ['lee soo young'], '장근석': ['geun seok jang', 'jang keun suk'],
  '박요한': ['park yo han'], '김장훈': ['kim jang-hoon'], '조관우': ['jo kwan woo'],
  '윤건': ['yoon gun'], '베니': ['venny'], '이카': ['ihka'], '정아': ['jung-a'],
  '강성': ['gang seong'], '류': ['ryu'], '이수': ['isu'], '남규리': ['nam gyu ri'],
  '백지영': ['baek z young', 'baek ji young'], '더 원': ['the one'],
  'sg wannabe': ['sg 워너비'], 'ft아일랜드': ['ftisland'],
  '허밍어반스테레오': ['hus', 'humming urban stereo'],
};

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
    const next = (v || '').trim();
    // Client ID 를 바꾸면 갖고 있던 토큰은 이전 앱의 것이다. 그대로 두면 새 앱으로
    // 바꾼 줄 알면서 실제 요청은 옛 앱으로 나간다. 요청 제한은 앱마다 매겨지므로
    // 막힌 앱을 벗어나려고 ID 를 바꿔도 아무 소용이 없어진다.
    if (next !== SpotifyAuth.clientId) {
      SpotifyAuth.logout();
      SpotifyAuth.blockedUntil = 0;
      SpotifyAuth.throttled = false;
    }
    if (next) localStorage.setItem(KEY_CLIENT, next);
    else localStorage.removeItem(KEY_CLIENT);
  }

  /** 대시보드에 등록해야 하는 Redirect URI. 쿼리·해시를 뺀 현재 페이지 주소. */
  static get redirectUri() {
    return location.origin + location.pathname;
  }

  static loadToken() {
    try {
      const t = JSON.parse(localStorage.getItem(KEY_TOKEN) || 'null');
      if (!t || !t.access_token) return null;
      // 다른 앱에서 받은 토큰은 쓰지 않는다. 새 앱으로 옮겼는데 옛 토큰이 남아
      // 있으면 요청이 계속 옛 앱 앞으로 달린다.
      // 어느 앱 것인지 안 적힌 토큰은 이 표시를 넣기 전에 받은 것이라 알 수가
      // 없다. 한 번은 다시 로그인하게 한다.
      if (t.client_id !== SpotifyAuth.clientId) return null;
      return t;
    } catch (_) { return null; }
  }

  static saveToken(t) {
    t.expires_at = Date.now() + (t.expires_in ?? 3600) * 1000 - 60_000; // 1분 여유
    t.client_id = SpotifyAuth.clientId;      // 어느 앱의 토큰인지 남긴다
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
  /**
   * 검색·조회 요청을 일정 간격으로 흘려보낸다.
   *
   * 개발 모드 앱은 할당량이 작다. 매칭 규칙을 고칠 때마다 전곡을 다시 찾느라
   * 그 할당량을 며칠에 걸쳐 태웠고, 결국 몇 시간을 못 쓰는 상태가 됐다.
   * 한도에 닿은 뒤에 물러서는 것보다 애초에 닿지 않는 편이 낫다.
   * 재생 요청은 게임 중에 바로 반응해야 하므로 늦추지 않는다.
   */
  static async _pace(path) {
    if (!/^\/(search|tracks|artists|albums)/.test(path)) return;
    const now = Date.now();
    const slot = Math.max(now, SpotifyAuth._nextSlot || 0);
    SpotifyAuth._nextSlot = slot + (SpotifyAuth._gap || REQUEST_GAP);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  static async api(path, options = {}, retry = true, tries = 1) {
    // 앱 단위로 막혀 있는 동안은 두드려 봐야 소용이 없다. 곡마다 다섯 번씩
    // 최대 1분을 기다리면 230곡 검사가 몇 시간이 된다.
    if (SpotifyAuth.blockedUntil && Date.now() < SpotifyAuth.blockedUntil) {
      // 우리가 지어낸 응답이다. Spotify 가 보낸 것과 헷갈리면 원인을 못 찾는다.
      return new Response('{"local":"blocked"}', { status: 429 });
    }
    await SpotifyAuth._pace(path);
    const token = await SpotifyAuth.getAccessToken();
    const res = await fetch(path.startsWith('http') ? path : SPOTIFY_API + path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
    if (res.status === 401 && retry) {
      const t = SpotifyAuth.loadToken();
      if (t) { t.expires_at = 0; localStorage.setItem(KEY_TOKEN, JSON.stringify(t)); }
      return SpotifyAuth.api(path, options, false, tries);
    }
    // 곡을 못 찾으면 표기를 바꿔 가며 여러 번 묻는다. 230개짜리 검사에서는 그게
    // 몰려 요청 제한에 걸린다. 한 번만 다시 시도하게 해 두었더니 부족했다.
    // 제한에 걸린 뒤로 회복하지 못하고 마흔 곡이 통째로 '검색 실패'로 끝났다.
    // 알려 주는 만큼 기다렸다가 여러 번 다시 시도하고, 걸렸다는 사실을 남겨
    // 검사 쪽이 속도를 늦추도록 한다.
    if (res.status === 429 && tries > 0) {
      // Retry-After 는 CORS 기본 노출 목록에 없어 브라우저에서 못 읽는 일이 많다.
      // 그걸 모르고 기본값 3초로 물러섰다가 열네 곡이 그대로 실패했다.
      // 못 읽으면 점점 길게 기다린다.
      // 오래 매달리지 않는다. 막힌 채로 계속 두드리면 제한이 더 길어진다.
      // 한 번만 짧게 쉬었다 확인하고, 그래도 막혀 있으면 검사를 접는다.
      const hinted = parseInt(res.headers.get('Retry-After') || '', 10);
      SpotifyAuth.lastRateLimit = {
        retryAfter: res.headers.get('Retry-After'),
        remaining: res.headers.get('x-ratelimit-remaining'),
        body: await res.clone().text().catch(() => '').then((t) => t.slice(0, 300)),
      };
      // 한도에 닿았으니 앞으로는 더 천천히 간다. 얼마가 한도인지 알 수 없으니
      // 겪으면서 늦춘다. 개발 모드 앱은 생각보다 훨씬 빡빡하다.
      SpotifyAuth._gap = Math.min(6000, (SpotifyAuth._gap || REQUEST_GAP) * 2);
      const wait = Number.isFinite(hinted) && hinted > 0 ? Math.min(30, hinted) : 6;
      SpotifyAuth.throttled = true;
      SpotifyAuth.blockedUntil = Date.now() + 30000;   // 잠시 손을 뗀다
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      return SpotifyAuth.api(path, options, retry, tries - 1);
    }
    return res;
  }
}

// ---------------------------------------------------------------- 트랙 매칭

/**
 * 곡 데이터에는 Spotify URI 가 비어 있으므로 검색으로 찾아 채운다.
 * 한 번 찾은 결과는 저장해 두어 매번 검색하지 않는다.
 */
/**
 * 한글 이름을 로마자로 옮긴다.
 *
 * Spotify 는 한국 가수를 로마자로 올려 두는 일이 많다(류→Ryu, 김장훈→Kim Jang-Hoon).
 * 글자로는 한 자도 안 겹치니 별칭표로는 감당이 안 된다 — OST 230개에 나오는
 * 가수를 전부 손으로 적을 수는 없다.
 */
const RM_CHO = ['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
const RM_JUNG = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u',
                 'wo','we','wi','yu','eu','ui','i'];
const RM_JONG = ['','k','k','k','n','n','n','t','l','l','l','l','l','l','l','l','m','p','p',
                 't','t','ng','t','t','k','t','p','t'];

function romanize(s) {
  let out = '';
  for (const ch of s || '') {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c >= 0 && c < 11172) {
      out += RM_CHO[Math.floor(c / 588)] + RM_JUNG[Math.floor((c % 588) / 28)] + RM_JONG[c % 28];
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * 로마자 표기의 흔들림을 지운다.
 *
 * 같은 이름도 적는 사람마다 다르다. Kim/Gim, Soo/Su, Seong/Sung, Park/Bak.
 * 소리가 같은 것끼리 묶어 하나로 만든다.
 */
function canonRoman(s) {
  let t = (s || '').toLowerCase().replace(/[^a-z]/g, '');
  t = t.replace(/oo/g, 'u').replace(/ou/g, 'u').replace(/ee/g, 'i');
  t = t.replace(/eo/g, 'u').replace(/eu/g, 'u').replace(/ae/g, 'e');
  t = t.replace(/ch/g, 'c').replace(/j/g, 'c');
  return t.replace(/[gk]/g, 'k').replace(/[dt]/g, 't')
          .replace(/[bp]/g, 'p').replace(/[rl]/g, 'l');
}

/** 두 글자열이 얼마나 닮았는가 ((0~1). 두 글자씩 끊어 겹치는 비율을 본다. */
function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const pairs = (x) => {
    const m = new Map();
    for (let i = 0; i < x.length - 1; i++) {
      const g = x.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = pairs(a), B = pairs(b);
  let hit = 0;
  for (const [g, n] of A) hit += Math.min(n, B.get(g) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

class SpotifyTrackResolver {
  constructor() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY_URIMAP) || '{}'); } catch (_) {}
    // 매칭 규칙이 바뀌면 예전에 붙여 둔 곡은 믿을 수 없다. 규칙을 고쳐 놓고도
    // 캐시가 남아 옛 결과가 그대로 쓰이면 고친 보람이 없다.
    if (saved.uris) {
      this.map = saved.uris;
      this.cache = saved.tracks || {};
    } else {
      // 예전에는 { 곡id: uri } 만 통째로 저장했다. 형식이 바뀌었다고 버리면
      // 어렵게 찾아 둔 것이 사라진다. 곡 정보는 없지만 uri 는 살릴 수 있다.
      this.map = Object.fromEntries(Object.entries(saved)
        .filter(([, v]) => typeof v === 'string' && v.startsWith('spotify:')));
      this.cache = {};
    }
    this.staleRules = saved.rules !== MATCH_RULES;
  }

  /**
   * 규칙이 바뀌었을 때 찾아 둔 것을 통째로 버리지 않는다.
   *
   * 처음엔 규칙이 바뀌면 전부 지웠는데, 그러면 멀쩡히 붙어 있던 곡까지 다시
   * 찾느라 Spotify 할당량을 태운다. 저장해 둔 곡 정보로 지금 규칙에도 맞는지
   * 그 자리에서 확인하고, 어긋나는 것만 지운다. 네트워크는 쓰지 않는다.
   */
  async revalidate(songs) {
    if (!this.staleRules) return null;
    await this._fillMissingTracks(songs);
    let kept = 0, dropped = 0;
    for (const song of songs) {
      if (song.spotifyUri) { kept++; continue; }   // 파일에 박힌 것은 그대로 둔다
      if (!this.map[song.id]) continue;
      if (SpotifyTrackResolver._stillValid(this.cache[song.id], song)) { kept++; continue; }
      delete this.map[song.id];
      delete this.cache[song.id];
      dropped++;
    }
    this.staleRules = false;
    this._save();
    return { kept, dropped };
  }

  /**
   * 곡 정보 없이 uri 만 남은 기록에 정보를 채운다.
   *
   * 한 곡씩 다시 검색하면 179곡이면 179번이다. Spotify 는 곡 정보를 50개씩
   * 묶어 주므로 네 번이면 끝난다. 지금처럼 할당량이 빠듯할 때 차이가 크다.
   */
  async _fillMissingTracks(songs) {
    const need = songs
      .map((s) => [s.id, (s.spotifyUri || this.map[s.id] || '').split(':').pop()])
      .filter(([id, tid]) => tid && !this.cache[id]?.name);
    for (let i = 0; i < need.length; i += 50) {
      const chunk = need.slice(i, i + 50);
      let res;
      try {
        res = await SpotifyAuth.api(`/tracks?ids=${chunk.map(([, t]) => t).join(',')}`);
      } catch (_) { return; }
      if (!res.ok) return;                       // 못 채우면 그 곡들은 다시 찾는다
      const items = (await res.json()).tracks || [];
      chunk.forEach(([id], j) => {
        const t = items[j];
        if (!t) return;
        this.cache[id] = {
          name: t.name,
          artists: (t.artists || []).map((a) => a.name).join(', '),
          album: t.album?.name || '',
          year: (t.album?.release_date || '').slice(0, 4),
        };
      });
    }
  }

  /**
   * 찾아 둔 것을 통째로 꺼낸다.
   *
   * Spotify 는 2026년 7월부터 개발 모드 할당량을 Client ID 가 아니라 개발자
   * 계정 단위로 센다. 앱을 새로 만들어도 같은 통에서 빠져나간다. 한 번 쓴
   * 할당량은 되돌릴 수 없으니, 어렵게 찾아 둔 것을 브라우저 안에만 두면
   * 안 된다. 꺼내서 데이터 파일에 박아 두면 다시는 찾지 않아도 된다.
   */
  export(songs = []) {
    const uris = {}, tracks = {};
    for (const [id, uri] of Object.entries(this.map)) {
      if (!uri) continue;
      uris[id] = uri;
      if (this.cache[id]?.name) tracks[id] = this.cache[id];
    }
    // 저장소는 모드별로 나뉘어 있지 않다. 어느 모드에서 눌러도 같은 수가 나와
    // 헷갈리므로, 지금 덱에 실제로 쓰이는 것이 몇인지 함께 알려 준다.
    const mine = songs.filter((s) => s.spotifyUri || uris[s.id]).length;
    return {
      rules: MATCH_RULES, count: Object.keys(uris).length,
      deck: { total: songs.length, have: mine, need: songs.length - mine },
      uris, tracks,
    };
  }

  /** 저장해 둔 매칭이 지금 규칙으로도 받아들여지는가. */
  static _stillValid(t, song) {
    if (!t || !t.name) return false;      // 곡 정보를 안 남긴 옛 기록
    const track = {
      name: t.name,
      artists: [{ name: t.artists || '' }],
      album: { name: t.album || '', release_date: String(t.year || '') },
    };
    const m = SpotifyTrackResolver._titleMatch(track.name, song);
    if (m <= 0) return false;
    if (SpotifyTrackResolver._isInstrumental(track)) return false;
    // 라이브·리믹스가 붙어 있었다면 규칙이 바뀐 김에 원곡을 다시 찾아 볼 만하다
    if (SpotifyTrackResolver._isVariant(track)) return false;
    const artistOk = SpotifyTrackResolver._artistOk(song.artist, t.artists || '');
    if (song.work) return artistOk || SpotifyTrackResolver._onWorkAlbum(t.album, song.work);
    return artistOk || m >= 1;
  }

  _save() {
    try {
      localStorage.setItem(KEY_URIMAP, JSON.stringify({
        rules: MATCH_RULES, uris: this.map, tracks: this.cache || {},
      }));
    } catch (_) {}
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
   * 비교용 제목 변형들.
   *
   * 한 곡의 제목이 한국어와 영어를 괄호로 함께 담는 일이 잦다
   * ('GANGNAM STYLE (강남스타일)', '소원을 말해봐 (Genie)').
   * 괄호 안을 버리면 한쪽 언어만 남아 반대쪽 표기와 영영 안 맞는다.
   * 전체 / 괄호 밖 / 괄호 안을 모두 만들어 하나라도 걸리면 같은 곡으로 본다.
   */
  static _titleForms(s) {
    const raw = s || '';
    const out = new Set([
      SpotifyTrackResolver._norm(raw.replace(/[()[\]]/g, ' ')),  // 괄호만 지우고 내용은 남김
      SpotifyTrackResolver._norm(raw),                            // 괄호 안을 버린 형태
    ]);
    for (const m of raw.matchAll(/[(\[]([^)\]]*)[)\]]/g)) {
      out.add(SpotifyTrackResolver._norm(m[1]));                  // 괄호 안만
    }
    out.delete('');
    return [...out];
  }

  /**
   * 이 곡을 가리키는 제목들.
   *
   * Spotify 한국은 한국 곡을 영어 제목으로만 올려 두는 일이 잦다.
   * 「에너제틱」은 'Energetic', 「첫 만남은 계획대로 되지 않아」는 'plot twist',
   * 「행복」은 'Full of happiness' 다. 한글 제목으로는 한 곡도 안 맞는다.
   * 큐레이션할 때 적어 둔 다른 표기(alt)와 수집 때 확인한 표기를 함께 쓴다.
   */
  static _titleNames(song) {
    return [SpotifyTrackResolver._title(song), song.alt, song.itunesTitle].filter(Boolean);
  }

  /** 비교용으로 펼친 제목 후보. */
  static _titleCandidates(song) {
    const forms = new Set();
    for (const t of SpotifyTrackResolver._titleNames(song)) {
      SpotifyTrackResolver._titleForms(t).forEach((f) => forms.add(f));
    }
    return [...forms];
  }

  /** 두 제목이 같은 곡을 가리키는가. */
  static _titleMatch(trackName, song) {
    const got = SpotifyTrackResolver._titleForms(trackName);
    const want = SpotifyTrackResolver._titleCandidates(song);
    let best = 0;
    for (const g of got) {
      for (const w of want) {
        if (!g || !w) continue;
        if (g === w) return 1;
        if (g.includes(w) || w.includes(g)) best = Math.max(best, 0.8);
      }
    }
    return best;
  }

  /**
   * 같은 가수인가.
   *
   * Spotify 는 한국 가수를 영문명으로 올려 둔 경우가 많다(아이유 → IU,
   * 방탄소년단 → BTS). 글자로만 비교하면 한 글자도 겹치지 않아 전부 불일치가 되고,
   * 그러면 한국 곡이 통째로 재생되지 않는다.
   */
  static _artistOk(seed, got) {
    const a = SpotifyTrackResolver._norm(got);
    const b = SpotifyTrackResolver._norm(seed);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const key = seed.trim().toLowerCase();
    for (const [k, list] of Object.entries(ARTIST_ALIASES)) {
      if (k !== key && !list.includes(key)) continue;
      for (const alias of [k, ...list]) {
        const c = SpotifyTrackResolver._norm(alias);
        if (c && (a.includes(c) || c.includes(a))) return true;
      }
    }
    // 별칭표에 없으면 소리로 견줘 본다. 로마자 표기는 적는 사람마다 흔들리므로
    // 똑같기를 바랄 수는 없고, 닮은 정도로 판단한다.
    return diceSimilarity(canonRoman(romanize(seed)), canonRoman(romanize(got)))
           >= ROMAN_MATCH;
  }

  /** 이 가수를 가리키는 이름들. 대조뿐 아니라 검색어를 만들 때도 쓴다. */
  static _artistNames(seed) {
    const key = (seed || '').trim().toLowerCase();
    const out = [seed];
    for (const [k, list] of Object.entries(ARTIST_ALIASES)) {
      if (k !== key && !list.includes(key)) continue;
      for (const a of [k, ...list]) if (!out.includes(a)) out.push(a);
    }
    return out;
  }

  /**
   * 이 트랙이 그 작품의 사운드트랙 음반에 실려 있는가.
   *
   * OST 는 같은 제목의 곡이 여기저기 있어 가수·제목만으로는 못 가린다.
   * 그 작품의 음반에 실려 있다는 것이 '이 작품의 OST' 라는 가장 확실한 증거다.
   * iTunes 로 곡을 모을 때도 같은 근거를 썼다.
   */
  static _onWorkAlbum(albumName, work) {
    const w = SpotifyTrackResolver._norm(work);
    return !!w && SpotifyTrackResolver._norm(albumName).includes(w);
  }

  /**
   * 곡 이름 자체가 그 작품의 것임을 밝히고 있는가.
   *
   * 'One Love (SBS 드라마 ′봄의 왈츠′ OST)' 처럼 음반이 아니라 곡명에 작품을
   * 적어 두는 경우가 있다. 음반만 보면 편집반이라 근거가 없는 것으로 읽힌다.
   * 다만 작품명이 흔한 말이면 동명의 다른 곡이 걸리므로(《굳세어라 금순아》에
   * 옛 트로트가 붙은 적이 있다), OST 라고 밝힌 것만 인정한다.
   */
  static _trackNamesWork(trackName, work, albumName) {
    // 편곡·리메이크 음반일수록 곡 이름에 원작을 밝혀 적는다.
    // '비와 당신 (슬기로운 의사생활 시즌2 OST)' 는 피아노 편곡반의 것이고
    // '약속 (드라마 아름다운 날들 OST)' 는 리메이크 음반의 것이다.
    // 이 표기를 근거로 인정하면 오히려 그런 음반만 골라 들이게 된다.
    const fake = { name: trackName, album: { name: albumName || '' } };
    if (SpotifyTrackResolver._isVariant(fake)) return false;
    if (SpotifyTrackResolver._isInstrumental(fake)) return false;
    const w = SpotifyTrackResolver._norm(work);
    // 작품명은 대개 괄호 안에 적힌다. 그런데 _norm 은 괄호 안을 통째로 버리므로
    // 'One Love (SBS 드라마 ′봄의 왈츠′ OST)' 에서 정작 찾을 것이 사라진다.
    // 여기서는 괄호 기호만 지우고 안은 남긴다.
    const t = SpotifyTrackResolver._norm((trackName || '').replace(/[()[\]]/g, ' '));
    if (!w || !t.includes(w)) return false;
    return /(ost|soundtrack|드라마|영화)/i.test(trackName || '');
  }

  /** 이 트랙이 그 작품의 것이라는 근거가 있는가. */
  static _refersToWork(albumName, trackName, work) {
    return SpotifyTrackResolver._onWorkAlbum(albumName, work)
        || SpotifyTrackResolver._trackNamesWork(trackName, work, albumName);
  }

  /**
   * 연주곡인가. 가사가 없어 듣고 맞힐 수가 없으므로 아예 쓰지 않는다.
   * 라이브·리믹스와 달리 '차선책'조차 되지 못한다.
   */
  static _isInstrumental(track) {
    const blob = `${track.name} ${track.album?.name || ''}`;
    // 드라마 OST 를 피아노·현악으로 다시 연주한 편집음반이 대량으로 올라와 있다.
    // 제목에 작품명이 그대로 들어 있어 검색에 잘 걸리는데, 가사가 없어 쓸 수 없다.
    return /(?<![a-z])(instrumental|inst|karaoke|mr\s*ver|backing\s*track|piano|cello|violin|orgel|music\s*box|new\s*age)(?![a-z])/i.test(blob)
        // 한국어는 뒤에 조사가 붙는다. '피아노로 듣는' 을 놓치지 않으려면
        // 뒷글자까지 막으면 안 된다.
        || /(?<![가-힣])(반주|연주곡|피아노|첼로|바이올린|오르골|뉴에이지|매장음악)/.test(blob);
  }

  /**
   * 원곡과 소리가 다른 버전인가. 원곡이 있으면 그쪽이 이기고,
   * 없으면 차선으로 쓴다 — 라이브라도 알아들을 수는 있기 때문이다.
   */
  static _isVariant(track) {
    // 'Korean Version' 은 언어판 표기다. 한국 가수에게는 그쪽이 원반이라
    // 변형으로 보고 감점하면 정작 원곡을 밀어낸다.
    const blob = `${track.name} ${track.album?.name || ''}`
      .replace(/(korean|japanese|chinese|english|mandarin)\s*(ver\.|version)/ig, ' ');
    return /(?<![a-z])(live|remix|remake|acoustic|cover|ver\.|version|edit|mixed|dj\s*mix)(?![a-z])/i.test(blob)
        || /(?<![가-힣])(라이브|리믹스|어쿠스틱|재녹음)(?![가-힣])/.test(blob);
  }

  static _score(track, song, rank = 0) {
    if (!SpotifyTrackResolver._title(song)) return -99;
    const m = SpotifyTrackResolver._titleMatch(track.name, song);

    // 가수가 다르면 제목이 같아도 다른 곡이다. iTunes 쪽에서 '폼생폼사'가 동명이곡으로
    // 잡혔던 사고와 같은 유형이라 여기서도 필수 조건으로 둔다.
    const artists = track.artists.map((a) => a.name).join(' ');
    const artistOk = SpotifyTrackResolver._artistOk(song.artist, artists);
    // 한국 가수는 로마자로 올라와 있는 일이 많다(류→Ryu, 김장훈→Kim Jang-Hoon).
    // 작품 음반에 실려 있으면 표기가 달라도 그 곡이 맞다.
    const onWork = SpotifyTrackResolver._refersToWork(track.album?.name, track.name, song.work);

    let s = 0;
    if (m >= 1) s += 5;                                       // 정확히 같으면 강한 신호
    else if (m > 0) s += 2;
    else return -50;                                          // 제목이 아예 다르면 탈락

    // 가수 표기가 안 맞아도 바로 버리지 않는다. 검색어에 이미 가수를 넣었으므로
    // 후보 자체가 그 가수로 좁혀져 있고, 표기 차이(아이유/IU)가 흔하기 때문이다.
    // 다만 제목까지 애매하면 다른 곡으로 본다.
    if (!artistOk) {
      if (m < 1) return -50;
      // OST 는 같은 제목의 곡이 널려 있다. 가수도 안 맞고 작품 음반도 아니면
      // 그냥 동명의 다른 곡이다 (이수 「Foolish Heart」 에 Sheena Easton 이 붙었다).
      if (song.work && !onWork) return -50;
      if (!onWork) s -= 1.5;
    }
    if (onWork) s += 3;

    // 검색어에 가수 이름을 넣었으므로 Spotify 가 매긴 순위 자체가 신호다.
    // 이게 없으면 '젝스키스 폼생폼사' 검색에서 동명이곡이 이겨 버린다.
    s += Math.max(0, 1.2 - rank * 0.4);

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
    return (await this.resolveDetailed(song)).uri;
  }

  /**
   * URI 뿐 아니라 무엇에 매칭됐는지까지 돌려준다.
   * Spotify 는 실행 중에 검색해 곡을 찾으므로, 미리 눈으로 확인할 방법이 없다.
   * 전곡을 훑어 '기대한 곡'과 '실제 매칭'을 대조하는 검사에 쓴다.
   */
  async resolveDetailed(song) {
    // 데이터에 박아 둔 주소가 있으면 찾지 않는다. 개발 모드 할당량은 개발자
    // 계정 단위로 세므로, 한 번 찾은 곡을 다시 찾는 것이 가장 큰 낭비다.
    if (song.spotifyUri) {
      return { uri: song.spotifyUri, track: this.cache?.[song.id] || null, cached: true };
    }
    if (this.map[song.id]) return { uri: this.map[song.id], track: this.cache?.[song.id] || null, cached: true };

    const title = SpotifyTrackResolver._title(song);
    const label = `${song.artist} - ${title}`;

    // 검색어가 하나뿐이면 표기가 다른 곡을 통째로 놓친다.
    //   가수 — '워너원'은 Spotify 색인에 없는 문자열이다. 'Wanna One' 으로만 올라와 있어
    //          한글로 물으면 걸리는 게 없다.
    //   곡   — 「나 홀로 뜰 앞에서」는 'Alone in Front of the Yard' 로만 올라와 있다.
    // 양쪽 표기를 조합해 차례로 시도한다. 첫 번째에서 찾으면 거기서 멈추므로
    // 평소에는 질의가 한 번이고, 못 찾은 곡만 더 두드린다.
    const titles = [...new Set(SpotifyTrackResolver._titleNames(song))];
    const terms = [];
    const add = (q, strict) => {
      if (q && !terms.some((x) => x.q === q)) terms.push({ q, strict });
    };
    // OST 는 작품명이 가수보다 확실한 단서다. 같은 제목의 곡이 여기저기 있어
    // '태민 발걸음' 은 엉뚱한 가수의 동명곡을 물어 왔다.
    // 'OST' 를 붙인 질의도 함께 던진다. 그냥 작품명만으로는 그 가수의 다른
    // 무대 영상이 먼저 올라오는 일이 있다(시크릿 가든 「그 여자」).
    for (const t of titles) {
      if (!song.work) continue;
      add(`${song.work} OST ${t}`, false);
      add(`${song.work} ${t}`, false);
    }
    for (const t of titles) {
      for (const n of SpotifyTrackResolver._artistNames(song.artist)) add(`${n} ${t}`, false);
    }
    // 마지막 수단으로 곡명만 던진다. 가수를 빼면 동명이곡이 섞이므로
    // 이때는 가수가 확인된 것만 받아들인다.
    for (const t of titles) add(t, true);

    // 한국어 곡명이 많아 필드 한정 검색보다 자유 질의가 더 잘 맞는다
    let scored = [];
    const tried = [];       // 실패했을 때 '무엇을 물었고 무엇이 왔는지' 남긴다
    for (const { q, strict } of terms) {
      const res = await SpotifyAuth.api(
        `/search?q=${encodeURIComponent(q)}&type=track&limit=10&market=KR`);
      if (!res.ok) throw new Error(`Spotify 검색 실패 (${res.status})`);
      const items = (await res.json()).tracks?.items || [];
      const round = items
        .map((t, i) => ({ t, s: SpotifyTrackResolver._score(t, song, i) }))
        .filter((x) => x.s > 0 && (!strict || SpotifyTrackResolver._artistOk(
          song.artist, x.t.artists.map((a) => a.name).join(' '))))
        .sort((a, b) => b.s - a.s);
      if (round.length && (!scored.length || round[0].s > scored[0].s)) scored = round;
      // 확실한 것을 찾았을 때만 멈춘다. 어설픈 후보에서 멈추면 뒤 질의가 막힌다.
      // '시그널 회상' 이 피아노 편곡을 물어 오는 바람에 '장범준 회상' 을 못 물었다.
      if (scored.length && scored[0].s >= 6) break;
      const top = items[0];
      tried.push(`"${q}" → ${items.length}건`
        + (top ? ` · 1위 ${top.artists.map((a) => a.name).join(', ')} / ${top.name}`
                 + ` (${SpotifyTrackResolver._score(top, song, 0).toFixed(1)}점)` : ''));
    }
    if (!scored.length) {
      // 한국 카탈로그에만 없는 것인지, 아예 없는 것인지 갈라 준다.
      // 곡이 분명히 있는데 market=KR 로 0건이 오는 경우가 있어 원인을 특정해야 한다.
      let extra = '';
      try {
        const res = await SpotifyAuth.api(
          `/search?q=${encodeURIComponent(terms[0].q)}&type=track&limit=5`);
        if (res.ok) {
          const items = (await res.json()).tracks?.items || [];
          const hit = items.find((t) => SpotifyTrackResolver._score(t, song, 0) > 0);
          extra = hit
            ? `\n    · 시장 제한을 풀면 있음 → ${hit.artists.map((a) => a.name).join(', ')}`
              + ` / ${hit.name}  (한국 계정으로는 재생 불가)`
            : `\n    · 시장 제한을 풀어도 없음 (${items.length}건)`;
        }
      } catch (_) { /* 진단일 뿐이라 실패해도 넘어간다 */ }
      throw new Error(`Spotify 에서 이 곡을 찾지 못했습니다: ${label}\n`
        + tried.map((t) => `    · ${t}`).join('\n') + extra);
    }

    const best = scored[0].t;
    this.map[song.id] = best.uri;
    (this.cache ||= {})[song.id] = {
      name: best.name,
      artists: best.artists.map((a) => a.name).join(', '),
      album: best.album?.name || '',
      year: (best.album?.release_date || '').slice(0, 4),
    };
    this._save();
    return { uri: best.uri, track: this.cache[song.id], score: scored[0].s, cached: false };
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

/**
 * 연결 진단.
 *
 * Spotify 재생이 안 될 때 원인이 여러 갈래다 — 요금제, 대시보드 사용자 등록,
 * Redirect URI 오타, SDK 로드 실패, 기기 연결, 곡 검색. 어디서 막혔는지
 * 말로 주고받으면 오래 걸려서, 순서대로 짚어 그 자리에서 보여준다.
 *
 * @param {object} sample 곡 하나 (검색까지 되는지 확인용)
 * @param {function} onStep 단계마다 호출: ({name, state, detail})
 *                          state: 'ok' | 'fail' | 'warn' | 'skip'
 * @param {SpotifyProvider} [active] 이미 연결된 플레이어. 있으면 그대로 쓴다.
 *   한 계정에 SDK 인스턴스를 둘 만들면 뒤엣것이 ready 를 받지 못해,
 *   앱은 멀쩡한데 진단만 '기기 연결 실패'로 나온다.
 */
async function diagnoseSpotify(sample, onStep, active = null) {
  const step = (name, state, detail) => onStep({ name, state, detail });
  const skipRest = (from, list) => list.slice(from).forEach((n) => step(n, 'skip', '앞 단계 실패로 건너뜀'));
  const NAMES = ['Client ID', '로그인 토큰', '계정 등급', '대시보드 사용자 등록',
                 'SDK 로드', '기기 연결', '곡 검색'];

  if (!SpotifyAuth.clientId) {
    step(NAMES[0], 'fail', '입력되지 않음');
    return skipRest(1, NAMES);
  }
  step(NAMES[0], 'ok', SpotifyAuth.clientId.slice(0, 8) + '…');

  let token;
  try {
    token = await SpotifyAuth.getAccessToken();
    const t = SpotifyAuth.loadToken();
    const left = Math.max(0, Math.round((t.expires_at - Date.now()) / 60000));
    step(NAMES[1], 'ok', `유효 (${left}분 남음)`);
  } catch (err) {
    step(NAMES[1], 'fail', err.message);
    return skipRest(2, NAMES);
  }

  let me;
  try {
    const res = await SpotifyAuth.api('/me');
    if (res.status === 403) {
      step(NAMES[2], 'fail', '권한 없음');
      step(NAMES[3], 'fail', '대시보드 User Management 에 이 계정 이메일을 추가해야 합니다');
      return skipRest(4, NAMES);
    }
    if (!res.ok) { step(NAMES[2], 'fail', `계정 정보를 못 읽음 (${res.status})`); return skipRest(3, NAMES); }
    me = await res.json();
    if (me.product === 'premium') step(NAMES[2], 'ok', `Premium (${me.display_name || me.id})`);
    else {
      step(NAMES[2], 'fail', `${me.product} — SDK 재생은 Premium 이 필요합니다`);
      step(NAMES[3], 'ok', '로그인된 것으로 보아 등록되어 있습니다');
      return skipRest(4, NAMES);
    }
    step(NAMES[3], 'ok', '등록되어 있습니다');
  } catch (err) {
    step(NAMES[2], 'fail', err.message);
    return skipRest(3, NAMES);
  }

  const reuse = active instanceof SpotifyProvider && active.deviceId;
  const player = reuse ? active : new SpotifyProvider();
  try {
    await SpotifyProvider._loadSdk();
    step(NAMES[4], 'ok', '불러옴');
  } catch (err) {
    step(NAMES[4], 'fail', err.message);
    return skipRest(5, NAMES);
  }

  try {
    const id = reuse ? player.deviceId : await player.connect();
    step(NAMES[5], 'ok', `기기 등록됨 (${String(id).slice(0, 8)}…)`
      + (reuse ? ' — 재생 중인 플레이어' : ''));
  } catch (err) {
    step(NAMES[5], 'fail', err.message);
    step(NAMES[6], 'skip', '앞 단계 실패로 건너뜀');
    if (!reuse) player.destroy();
    return;
  }

  // 검색은 상태 코드만으로는 왜 막혔는지 알 수 없다. 응답을 그대로 보여준다.
  try {
    SpotifyAuth.blockedUntil = 0;      // 진단은 진짜 응답을 봐야 한다
    const res = await SpotifyAuth.api('/search?q=test&type=track&limit=1&market=KR');
    if (res.ok) {
      const uri = await player.resolver.resolve(sample);
      const title = SpotifyTrackResolver._title(sample);
      step(NAMES[6], 'ok', `${sample.artist} — ${title} → ${uri.split(':').pop().slice(0, 8)}…`);
    } else {
      let body = '';
      try { body = (await res.text()).slice(0, 300); } catch (_) {}
      // 앞서 겪은 진짜 제한 응답이 있으면 그쪽이 더 쓸모 있다
      const seen = SpotifyAuth.lastRateLimit;
      if (seen && (seen.body || seen.retryAfter)) {
        body = (body ? body + ' | ' : '')
             + `직전 실제 응답: ${seen.body || '(본문 없음)'}`
             + (seen.retryAfter ? ` retry-after=${seen.retryAfter}` : '')
             + (seen.remaining ? ` remaining=${seen.remaining}` : '');
      }
      const hdr = ['retry-after', 'x-ratelimit-remaining', 'x-ratelimit-limit']
        .map((h) => [h, res.headers.get(h)]).filter(([, v]) => v)
        .map(([h, v]) => `${h}=${v}`).join(' · ');
      step(NAMES[6], 'fail',
        `HTTP ${res.status} ${res.statusText || ''}`.trim()
        + (hdr ? ` · ${hdr}` : ' · (헤더 안 보임 — CORS 로 가려짐)')
        + (body ? `\n응답: ${body}` : '\n응답 본문 없음'));
    }
  } catch (err) {
    step(NAMES[6], 'fail', `요청 자체가 실패: ${err.message}`);
  }
  if (!reuse) player.destroy();   // 앱이 쓰는 플레이어는 끊지 않는다
}

/**
 * 덱 전체를 Spotify 에서 찾아보고 무엇에 매칭됐는지 돌려준다.
 *
 * @param {Array} songs 검사할 곡 목록
 * @param {function} onResult 한 곡 끝날 때마다: ({song, track, state, note, done, total})
 *                            state: 'ok' | 'warn' | 'fail'
 * @param {object} opts {delay, signal}
 */
/**
 * 요청 제한이 풀릴 때까지 기다린다.
 *
 * 막힐 때마다 사람이 다시 눌러야 하면 언제 열릴지 몰라 계속 붙들려 있게 된다.
 * 점점 긴 간격으로 한 번씩만 두드려 보고, 열리면 이어서 간다.
 * 자주 두드릴수록 제한이 길어지므로 두드리는 횟수를 아낀다.
 */
async function waitForQuota(onResult, signal, at) {
  const steps = [60, 180, 420, 900, 1800, 1800, 1800];   // 1분 → 30분
  for (let n = 0; n < steps.length; n++) {
    for (let left = steps[n]; left > 0 && !signal?.aborted; left -= 5) {
      const m = Math.floor(left / 60), sec = left % 60;
      onResult({ transient: true, notice:
        `Spotify 요청 제한이 걸려 기다리는 중입니다 · ${at.done}/${at.total}곡 마침`
        + ` — ${m ? m + '분 ' : ''}${sec}초 뒤 다시 확인합니다` });
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (signal?.aborted) return false;
    // 속도 제한이 아니라 할당량이 바닥난 것이면 몇 분 기다려도 소용없다.
    // Spotify 는 회복 시점을 공개하지 않지만, 분 단위가 아닌 것은 분명하다.
    if (SpotifyAuth.lastRateLimit?.body?.includes('QUOTA_EXCEEDED')) return false;
    onResult({ transient: true, notice: '제한이 풀렸는지 확인하는 중…' });
    SpotifyAuth.blockedUntil = 0;
    let res;
    try {
      res = await SpotifyAuth.api('/search?q=a&type=track&limit=1', {}, true, 0);
    } catch (_) { continue; }
    if (res.ok) {
      SpotifyAuth.throttled = true;      // 풀렸어도 조심스럽게 간다
      return true;
    }
  }
  return false;
}

async function auditSpotifyMatches(songs, onResult, { delay = 0, signal } = {}) {
  const resolver = new SpotifyTrackResolver();
  onResult({ transient: true, notice:
    `Spotify 한도에 닿지 않도록 ${((SpotifyAuth._gap || REQUEST_GAP) / 1000).toFixed(1)}초에 한 곡씩 찾습니다.`
    + ` 이미 찾아 둔 곡은 건너뛰므로 실제로는 더 빠릅니다.` });
  const moved = await resolver.revalidate(songs);
  if (moved) onResult({ notice: `곡 고르는 규칙이 바뀌어 다시 확인했습니다 — `
    + `${moved.kept}곡은 그대로 두고 ${moved.dropped}곡만 다시 찾습니다.` });
  let blocked = 0;

  for (let i = 0; i < songs.length; i++) {
    if (signal?.aborted) return;
    const song = songs[i];
    let state = 'ok', note = '', track = null, hitNetwork = false;

    try {
      const r = await resolver.resolveDetailed(song);
      track = r.track;
      hitNetwork = !r.cached;
      if (!track) {
        note = '이전에 찾아 둔 결과 (상세 없음)';
      } else {
        // 기대한 가수·곡과 실제로 붙은 트랙을 대조한다.
        // 판정 기준은 곡을 고를 때 쓴 것과 같아야 한다. 여기만 엄격하게 두면
        // 'Alone in Front of the Yard'(「나 홀로 뜰 앞에서」)처럼 제대로 찾은 곡이
        // 전부 경고로 뜬다.
        if (SpotifyTrackResolver._titleMatch(track.name, song) <= 0) {
          state = 'warn'; note = '곡 제목이 다릅니다';
        }
        else if (!SpotifyTrackResolver._artistOk(song.artist, track.artists)
                 && !SpotifyTrackResolver._refersToWork(track.album, track.name, song.work)) {
          state = 'warn'; note = `가수가 다릅니다 (기대 ${song.artist})`;
        }
        else if (/(?<![a-z])(live|remix|acoustic|ver\.|version|edit|mixed|dj\s*mix)(?![a-z])/i.test(track.name + ' ' + track.album)) {
          state = 'warn'; note = '원곡이 아닌 버전일 수 있습니다';
        }
        // OST 는 같은 제목의 곡이 여기저기 있다. 작품 음반이 아니면 조용히
        // 엉뚱한 곡이 뽑힐 수 있는데, 게임 중에는 티가 안 나니 짚어 둔다.
        // OST 는 같은 제목의 곡이 여기저기 있다. 작품 음반이 아니면 조용히 엉뚱한
        // 곡이 뽑힐 수 있는데 게임 중에는 티가 안 난다.
        // 다만 작품명이 영문으로 올라온 음반(미생→Misaeng)은 정상이므로,
        // 사운드트랙 음반이면서 가수도 맞으면 짚지 않는다.
        // 가수가 맞을 때만 봐준다. 이 단서를 가수와 무관하게 적용했더니
        // '드라마 OST 피아노' 같은 편곡 음반이 경고를 빠져나갔다.
        else if (song.work
                 && !SpotifyTrackResolver._refersToWork(track.album, track.name, song.work)
                 && !(SpotifyTrackResolver._artistOk(song.artist, track.artists)
                      && /(ost|soundtrack)/i.test(track.album || ''))) {
          state = 'warn'; note = `작품 음반이 아닙니다 (${song.work} OST 인지 확인 필요)`;
        }
      }
    } catch (err) {
      state = 'fail';
      note = err.message;
      hitNetwork = true;          // 실패도 부른 것은 부른 것이다
    }
    onResult({ song, track, state, note, done: i + 1, total: songs.length });

    // 연달아 막히면 계정이 아니라 앱 전체가 잠긴 것이다. 남은 곡을 붙들고
    // 있어 봐야 시간만 버리고 제한만 더 길어진다. 여기서 멈추는 게 낫다.
    blocked = /\(429\)/.test(note) ? blocked + 1 : 0;
    if (blocked >= 3) {
      // 앱 전체가 잠긴 것이다. 검사를 접는 대신 열릴 때까지 기다렸다 이어간다.
      // 언제 열릴지 몰라 사람이 계속 눌러 보게 만드는 것이 제일 나쁘다.
      const open = await waitForQuota(onResult, signal, { done: i, total: songs.length });
      if (!open) {
        onResult({
          song, track: null, state: 'fail', done: i + 1, total: songs.length, halted: true,
          note: (SpotifyAuth.lastRateLimit?.body?.includes('QUOTA_EXCEEDED')
                 ? `Spotify 개발 모드 할당량을 다 썼습니다 (${i}곡까지 마침). `
                   + '속도 문제가 아니라 개발자 계정에 걸린 한도라, 기다려서 풀립니다. '
                   + '지금까지 찾은 곡은 저장돼 있으니 [찾은 곡 내보내기] 로 꺼내 두세요.'
                 : `한참 기다려도 Spotify 요청 제한이 풀리지 않아 검사를 멈춥니다 (${i}곡까지 마침). `)
              + ' 나중에 다시 누르면 남은 곡부터 이어서 합니다.',
        });
        return;
      }
      blocked = 0;
      i -= 1;                 // 막혔던 곡부터 다시
      continue;
    }
    // 요청 간격은 이제 SpotifyAuth 가 지킨다. 여기서 또 쉬면 이중으로 느려진다.
    // 한 번 제한에 걸린 뒤에만 더 물러선다.
    const gap = !hitNetwork ? 0 : (SpotifyAuth.throttled ? Math.max(delay, 2000) : delay);
    if (!signal?.aborted && gap) await new Promise((r) => setTimeout(r, gap));
  }
}

window.auditSpotifyMatches = auditSpotifyMatches;
window.diagnoseSpotify = diagnoseSpotify;
window.RESOLVER_BUILD = RESOLVER_BUILD;
window.SpotifyAuth = SpotifyAuth;
window.SpotifyProvider = SpotifyProvider;
window.SpotifyTrackResolver = SpotifyTrackResolver;
