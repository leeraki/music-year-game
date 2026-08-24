/**
 * 덱 관리 — 곡 목록 적재, 필터, 셔플, 중복 없는 뽑기, 진행 상태 보존.
 *
 * 한 판 안에서 같은 곡이 두 번 나오면 게임이 망가지므로,
 * 뽑기는 매번 난수를 굴리지 않고 '셔플된 순서를 소진'하는 방식으로 한다.
 */

const STORAGE_KEY = 'music-game/deck-state/v1';

// 모드별로 곡 목록과 진행 상태를 따로 둔다.
// 한 모드에서 덱을 소진해도 다른 모드는 그대로 이어갈 수 있어야 하기 때문이다.
const MODES = {
  kpop: { file: 'data/kpop.json', label: 'K-POP' },
  ost:  { file: 'data/ost.json',  label: '영화·드라마 OST' },
};

class Deck {
  constructor(mode = 'kpop') {
    this.mode = MODES[mode] ? mode : 'kpop';
    this.all = [];        // 원본 전체
    this.pool = [];       // 필터 적용 후 대상
    this.order = [];      // 셔플된 인덱스 순서
    this.cursor = 0;      // 다음에 뽑을 order 위치
    this.history = [];    // 이미 나온 곡 (최근이 뒤)
    this.filter = { from: null, to: null };
  }

  static get MODES() { return MODES; }

  async load(mode = this.mode) {
    this.mode = MODES[mode] ? mode : 'kpop';
    const res = await fetch(MODES[this.mode].file, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`곡 목록을 불러오지 못했습니다 (${res.status})`);
    const data = await res.json();
    // 데이터에 같은 트랙이 두 번 들어가면 한 판에 같은 곡이 두 번 나온다.
    // 수집 단계에서도 막지만, 데이터를 손으로 고칠 수 있으니 여기서도 한 번 더 거른다.
    const seen = new Set();
    this.all = (data.songs || []).filter((s) => {
      if (!s.previewUrl || !s.year) return false;
      const key = s.itunesTrackId ?? s.id;
      if (seen.has(key)) {
        console.warn('중복 곡을 건너뜁니다:', s.artist, '-', s.title || s.work);
        return false;
      }
      seen.add(key);
      return true;
    });
    if (!this.all.length) throw new Error('사용 가능한 곡이 없습니다');
    this.applyFilter(this.filter, { keepProgress: false });
    return this.all.length;
  }

  /** 연대 범위 필터. 바꾸면 덱을 새로 섞는다. */
  applyFilter({ from = null, to = null } = {}, { keepProgress = false } = {}) {
    this.filter = { from, to };
    this.pool = this.all.filter((s) => {
      if (from !== null && s.year < from) return false;
      if (to !== null && s.year > to) return false;
      return true;
    });
    if (!keepProgress) this.reshuffle();
  }

  reshuffle() {
    this.order = this.pool.map((_, i) => i);
    // Fisher-Yates
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
    this.cursor = 0;
    this.history = [];
  }

  get remaining() { return Math.max(0, this.order.length - this.cursor); }
  get total() { return this.order.length; }
  get used() { return this.cursor; }
  get isEmpty() { return this.remaining === 0; }

  /** 다음 곡을 뽑는다. 덱이 비면 null. */
  draw() {
    if (this.isEmpty) return null;
    const song = this.pool[this.order[this.cursor]];
    this.cursor += 1;
    this.history.push(song);
    this.save();
    return song;
  }

  /** 뽑지 않고 다음 곡만 훔쳐본다 (프리페치용). */
  peek(offset = 0) {
    const idx = this.cursor + offset;
    if (idx >= this.order.length) return null;
    return this.pool[this.order[idx]];
  }

  /** 방금 뽑은 곡을 덱에 되돌린다 (재생 실패 시 복구용). */
  undo() {
    if (this.cursor === 0) return;
    this.cursor -= 1;
    this.history.pop();
    this.save();
  }

  /** 연대 분포 — 설정 화면에서 필터 결과를 미리 보여주는 데 쓴다. */
  decadeBreakdown(pool = this.pool) {
    const map = new Map();
    pool.forEach((s) => {
      const d = Math.floor(s.year / 10) * 10;
      map.set(d, (map.get(d) || 0) + 1);
    });
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }

  countInRange(from, to) {
    return this.all.filter(
      (s) => (from === null || s.year >= from) && (to === null || s.year <= to)
    ).length;
  }

  get yearBounds() {
    const years = this.all.map((s) => s.year);
    return { min: Math.min(...years), max: Math.max(...years) };
  }

  save() {
    try {
      localStorage.setItem(`${STORAGE_KEY}/${this.mode}`, JSON.stringify({
        filter: this.filter,
        order: this.order,
        cursor: this.cursor,
        historyIds: this.history.map((s) => s.id),
      }));
    } catch (_) { /* 저장 실패는 게임 진행을 막지 않는다 */ }
  }

  /** 저장된 진행 상태를 복원한다. 곡 목록이 바뀌었으면 조용히 포기하고 새로 시작. */
  restore() {
    try {
      const raw = localStorage.getItem(`${STORAGE_KEY}/${this.mode}`);
      if (!raw) return false;
      const st = JSON.parse(raw);
      this.applyFilter(st.filter || {}, { keepProgress: true });
      if (!Array.isArray(st.order) || st.order.length !== this.pool.length) return false;
      this.order = st.order;
      this.cursor = Math.min(st.cursor || 0, this.order.length);
      const byId = new Map(this.all.map((s) => [s.id, s]));
      this.history = (st.historyIds || []).map((id) => byId.get(id)).filter(Boolean);
      return this.cursor > 0;
    } catch (_) {
      return false;
    }
  }

  clearSaved() {
    try { localStorage.removeItem(`${STORAGE_KEY}/${this.mode}`); } catch (_) {}
  }
}

window.Deck = Deck;
