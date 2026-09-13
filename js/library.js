/**
 * 곡 목록 탭.
 *
 * 덱 전체를 훑어보며 음원을 들어 보고, 이상한 곡은 「재검수」, 뺄 곡은 「빼기」로
 * 표시하고, 넣고 싶은 곡은 추가 요청으로 적어 둔다.
 *
 * 앱은 표시만 한다. 음원을 다시 찾고 연도를 확인하는 일은 요청 파일을 넘겨받아
 * 나중에 한꺼번에 처리한다 — 앱 안에서 하려면 검색 할당량과 판단 기준을 모두
 * 브라우저에 들여야 해서다.
 *
 * 표시는 이 브라우저에만 쌓인다. 기기 사이에 옮겨지지 않으므로 파일로 저장해
 * 전달한다. 처리가 끝난 요청은 data/processed.json 에 올라가고, 앱이 그걸 보고
 * 표시를 지운다. 덱 자체가 바뀌는 것은 처리해서 배포한 뒤다 — 기기마다 덱이
 * 달라지는 일을 막으려는 것이다.
 */
(() => {
  'use strict';

  const REQUEST_KEY = 'music-game/requests/v1';
  const PROCESSED_URL = 'data/processed.json';
  const MODE_KEYS = ['kpop', 'ost'];
  const KIND_LABEL = { add: '추가', recheck: '재검수', remove: '빼기' };

  const now = () => new Date().toISOString();
  const newRid = (prefix) =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // 띄어쓰기·문장부호·대소문자 차이는 같은 것으로 본다
  const norm = (s) => String(s ?? '').toLowerCase().normalize('NFC').replace(/[^0-9a-z가-힣]/g, '');
  const clock = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:`
      + String(d.getMinutes()).padStart(2, '0');
  };

  /** 요청을 브라우저에 쌓아 둔다. 모드마다 따로 둔다. */
  class RequestStore {
    constructor() { this.data = RequestStore._read(); }

    static _read() {
      try {
        const d = JSON.parse(localStorage.getItem(REQUEST_KEY) || '{}');
        return { modes: d.modes || {}, changedAt: d.changedAt || null, savedAt: d.savedAt || null };
      } catch (_) {
        return { modes: {}, changedAt: null, savedAt: null };
      }
    }

    _write(changed = true) {
      if (changed) this.data.changedAt = now();
      try { localStorage.setItem(REQUEST_KEY, JSON.stringify(this.data)); } catch (_) {}
    }

    of(mode) {
      const m = (this.data.modes[mode] ||= {});
      m.add ||= [];
      m.recheck ||= {};
      m.remove ||= {};
      return m;
    }

    stateOf(mode, id) {
      const m = this.of(mode);
      if (m.remove[id]) return 'remove';
      if (m.recheck[id]) return 'recheck';
      return '';
    }

    /** 재검수와 빼기는 한 곡에 하나만 둔다. 같은 것을 다시 누르면 풀린다. */
    toggle(mode, kind, song) {
      const m = this.of(mode);
      const other = kind === 'recheck' ? 'remove' : 'recheck';
      if (m[kind][song.id]) {
        delete m[kind][song.id];
      } else {
        m[kind][song.id] = {
          rid: newRid(kind === 'recheck' ? 'rc' : 'rm'),
          at: now(),
          note: '',
          // 처리 전에 곡이 바뀌어도 무엇을 표시했는지 알 수 있게 남겨 둔다
          song: {
            year: song.year, artist: song.artist || '',
            title: song.title || song.song || '', work: song.work || '',
          },
        };
        delete m[other][song.id];
      }
      this._write();
    }

    setNote(mode, id, text) {
      const e = this.of(mode).recheck[id];
      if (!e || e.note === text) return;
      e.note = text;
      this._write();
    }

    add(mode, entry) {
      this.of(mode).add.push({ rid: newRid('ad'), at: now(), ...entry });
      this._write();
    }

    cancel(mode, kind, key) {
      const m = this.of(mode);
      if (kind === 'add') m.add = m.add.filter((a) => a.rid !== key);
      else delete m[kind][key];
      this._write();
    }

    counts(mode) {
      const m = this.of(mode);
      return {
        add: m.add.length,
        recheck: Object.keys(m.recheck).length,
        remove: Object.keys(m.remove).length,
      };
    }

    get total() {
      return MODE_KEYS.reduce((n, k) => {
        const c = this.counts(k);
        return n + c.add + c.recheck + c.remove;
      }, 0);
    }

    /** 마지막으로 파일에 담은 뒤에 바뀐 것이 있는가 */
    get unsaved() {
      return this.total > 0 && (!this.data.savedAt || this.data.changedAt > this.data.savedAt);
    }

    markSaved() {
      this.data.savedAt = now();
      this._write(false);
    }

    /** 처리가 끝난 요청을 지우고, 지운 개수를 돌려준다. */
    prune(done) {
      let n = 0;
      for (const k of MODE_KEYS) {
        const m = this.of(k);
        const before = m.add.length;
        m.add = m.add.filter((a) => !done.has(a.rid));
        n += before - m.add.length;
        for (const kind of ['recheck', 'remove']) {
          for (const [id, e] of Object.entries(m[kind])) {
            if (done.has(e.rid)) { delete m[kind][id]; n += 1; }
          }
        }
      }
      if (n) this._write(false);
      return n;
    }
  }

  class SongLibrary {
    /**
     * @param {object} hooks
     * @param {() => object|null} hooks.spotify  게임이 연결해 둔 Spotify 재생기.
     *   한 계정에 SDK 재생기를 둘 만들면 뒤엣것이 연결을 못 받으므로 빌려 쓴다.
     * @param {() => number} hooks.volume  0~1
     * @param {() => string} hooks.mode  게임의 현재 모드
     * @param {() => void} hooks.beforePreview  목록에서 듣기 전에 게임 소리를 멈춘다
     * @param {(usedSpotify: boolean) => void} hooks.afterClose
     */
    constructor(hooks) {
      this.hooks = hooks;
      this.store = new RequestStore();
      this.decks = {};
      this.index = {};
      this.mode = 'kpop';
      this.filter = 'all';
      this.query = '';
      this.isOpen = false;
      this.resolver = null;
      this.pruned = 0;

      // 미리듣기는 게임 재생기와 따로 둔다. 게임 중에 열어도 그 곡이 그대로 남는다.
      this.itunes = new ItunesPreviewProvider();
      this.itunes.on('ended', () => { if (this.previewPlayer === this.itunes) this.stopPreview(); });
      this.previewPlayer = null;
      this.playingId = null;
      this.playState = null;
      this.usedSpotify = false;
      this._wired = new WeakSet();

      const $ = (id) => document.getElementById(id);
      this.el = {
        root: $('library'), button: $('btn-library'),
        modes: $('lib-modes'), search: $('lib-search'), filters: $('lib-filters'),
        engineNote: $('lib-engine-note'),
        reqSummary: $('lib-req-summary'), save: $('lib-save'), saveNote: $('lib-save-note'),
        reqList: $('lib-req-list'), addForm: $('lib-add-form'), list: $('lib-list'),
      };
      this._bind();
      this.refreshBadge();
    }

    // ---------- 열고 닫기 ----------
    async open() {
      if (this.isOpen) return;
      this.isOpen = true;
      this.el.root.hidden = false;
      this.mode = this.hooks.mode();
      this.filter = 'all';
      this.renderModes();
      this.el.list.replaceChildren(this._empty('곡 목록을 불러오는 중…'));
      try {
        await Promise.all([this.loadDecks(), this.syncProcessed()]);
      } catch (err) {
        this.el.list.replaceChildren(this._empty(`곡 목록을 불러오지 못했습니다. ${err.message}`));
        return;
      }
      this.resolver = this.hooks.spotify()?.resolver
        || (typeof SpotifyTrackResolver !== 'undefined' ? new SpotifyTrackResolver() : null);
      this.renderAll();
      this.fillSpotifyInfo();
    }

    close() {
      if (!this.isOpen) return;
      this.stopPreview();
      this.isOpen = false;
      this.el.root.hidden = true;
      const used = this.usedSpotify;
      this.usedSpotify = false;
      this.hooks.afterClose?.(used);
    }

    async loadDecks() {
      await Promise.all(MODE_KEYS.map(async (k) => {
        if (this.decks[k]) return;
        const res = await fetch(Deck.MODES[k].file, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${Deck.MODES[k].label} (${res.status})`);
        // 게임과 같은 곡만 보여 준다
        const songs = ((await res.json()).songs || []).filter((s) => s.previewUrl && s.year);
        this.decks[k] = songs;
        this.index[k] = new Map(songs.map((s) => [s.id, s]));
      }));
    }

    /** 처리가 끝난 요청의 표시를 지운다. 기록 파일이 없어도 목록은 쓸 수 있다. */
    async syncProcessed() {
      try {
        const res = await fetch(PROCESSED_URL, { cache: 'no-cache' });
        if (!res.ok) return;
        const n = this.store.prune(new Set((await res.json()).requests || []));
        if (n) this.pruned = n;
      } catch (_) { /* 없어도 된다 */ }
      this.refreshBadge();
    }

    /** 곡 정보가 비어 있는 Spotify 곡이 있으면 뒤에서 채운다. 로그인해 있을 때만. */
    async fillSpotifyInfo() {
      const r = this.resolver;
      if (!r?.fillTrackInfo || typeof SpotifyAuth === 'undefined' || !SpotifyAuth.isLoggedIn) return;
      const songs = MODE_KEYS.flatMap((k) => this.decks[k] || []);
      const missing = songs.filter((s) => s.spotifyUri && !r.trackInfo(s)).length;
      if (!missing) return;
      this.renderEngineNote(`Spotify 곡 정보 ${missing}곡을 불러오는 중…`);
      try { await r.fillTrackInfo(songs); } catch (_) {}
      if (!this.isOpen) return;
      this.renderEngineNote();
      this.el.list.querySelectorAll('.lib-row').forEach((row) => {
        const s = this.songById(row.dataset.id);
        if (s) this.renderSource(row, s);
      });
    }

    // ---------- 이벤트 ----------
    _bind() {
      const { el } = this;
      el.root.addEventListener('click', (e) => {
        if (e.target.closest('[data-lib-close]')) this.close();
      });
      el.modes.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (chip && chip.dataset.mode !== this.mode) this.switchMode(chip.dataset.mode);
      });

      let timer = null;
      el.search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { this.query = el.search.value; this.renderList(); }, 120);
      });

      el.filters.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        this.filter = chip.dataset.filter;
        this.renderFilters();
        this.renderList();
      });

      el.list.addEventListener('click', (e) => {
        const row = e.target.closest('.lib-row');
        const song = row && this.songById(row.dataset.id);
        if (!song) return;
        if (e.target.closest('.lib-play')) { this.togglePreview(song); return; }
        const mark = e.target.closest('.lib-mark');
        if (mark) {
          this.store.toggle(this.mode, mark.dataset.kind, song);
          this.updateRow(row, song);
          if (mark.dataset.kind === 'recheck' && row.dataset.state === 'recheck') {
            row.querySelector('.lib-note').focus({ preventScroll: true });
          }
          this.afterChange();
        }
      });

      el.list.addEventListener('input', (e) => {
        const note = e.target.closest('.lib-note');
        if (!note) return;
        this.store.setNote(this.mode, note.closest('.lib-row').dataset.id, note.value.trim());
        this.renderRequests();
        this.refreshBadge();
      });

      el.reqList.addEventListener('click', (e) => {
        const btn = e.target.closest('.lib-cancel');
        if (!btn) return;
        const { kind, key } = btn.dataset;
        this.store.cancel(this.mode, kind, key);
        const row = kind !== 'add' && this.rowOf(key);
        if (row) this.updateRow(row, this.songById(key));
        this.afterChange();
      });

      el.addForm.addEventListener('submit', (e) => { e.preventDefault(); this.submitAdd(); });
      el.save.addEventListener('click', () => this.save());

      document.addEventListener('keydown', (e) => {
        if (this.isOpen && e.key === 'Escape') this.close();
      });
    }

    switchMode(mode) {
      this.stopPreview();
      this.mode = mode;
      this.filter = 'all';
      this.renderAll();
    }

    afterChange() {
      this.renderFilters();
      this.renderRequests();
      this.refreshBadge();
    }

    songs() { return this.decks[this.mode] || []; }
    songById(id) { return this.index[this.mode]?.get(id) || null; }
    rowOf(id) { return this.el.list.querySelector(`.lib-row[data-id="${CSS.escape(id)}"]`); }

    _empty(text) {
      const li = document.createElement('li');
      li.className = 'lib-empty';
      li.textContent = text;
      return li;
    }

    // ---------- 그리기 ----------
    renderAll() {
      this.renderModes();
      this.renderEngineNote();
      this.renderFilters();
      this.renderRequests();
      this.renderAddForm();
      this.renderList();
    }

    renderModes() {
      this.el.modes.querySelectorAll('.chip').forEach((c) =>
        c.setAttribute('aria-pressed', String(c.dataset.mode === this.mode)));
    }

    renderEngineNote(text = '', kind = '') {
      const note = this.el.engineNote;
      if (text) {
        note.textContent = text;
        note.className = 'field-note' + (kind ? ` status-${kind}` : '');
        return;
      }
      const sp = this.hooks.spotify();
      note.textContent = sp
        ? '▶ 는 게임에서 실제로 나가는 음원을 그대로 틉니다. Spotify 곡은 풀 트랙입니다.'
        : 'Spotify 재생기가 꺼져 있어 모두 30초 미리듣기로 나옵니다. 게임과 같은 음원을 '
          + '들으려면 설정에서 재생 엔진을 Spotify 로 바꿔 주세요.';
      note.className = 'field-note' + (sp ? '' : ' status-warn');
    }

    toast(text) {
      this.renderEngineNote(text, 'warn');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { if (this.isOpen) this.renderEngineNote(); }, 5000);
    }

    renderFilters() {
      const songs = this.songs();
      const c = this.store.counts(this.mode);
      const sp = songs.filter((s) => s.spotifyUri).length;
      const defs = [
        ['all', '전체', songs.length],
        ['spotify', 'Spotify', sp],
        ['preview', '미리듣기만', songs.length - sp],
        ['recheck', '재검수', c.recheck],
        ['remove', '빼기', c.remove],
      ];
      this.el.filters.replaceChildren(...defs.map(([key, label, n]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.dataset.filter = key;
        b.setAttribute('aria-pressed', String(this.filter === key));
        const count = document.createElement('span');
        count.className = 'chip-count';
        count.textContent = n;
        b.append(label, count);
        return b;
      }));
    }

    matches(song) {
      const st = this.store.stateOf(this.mode, song.id);
      if (this.filter === 'spotify' && !song.spotifyUri) return false;
      if (this.filter === 'preview' && song.spotifyUri) return false;
      if (this.filter === 'recheck' && st !== 'recheck') return false;
      if (this.filter === 'remove' && st !== 'remove') return false;
      const q = norm(this.query);
      if (!q) return true;
      const hay = norm([
        song.year, song.artist, song.title, song.alt, song.work, song.song, song.itunesTitle,
        ...(song.characters || []).flatMap((c) => [c.name, c.actor]),
      ].join(' '));
      return hay.includes(q);
    }

    renderList() {
      const shown = this.songs().filter((s) => this.matches(s));
      if (!shown.length) {
        this.el.list.replaceChildren(this._empty('조건에 맞는 곡이 없습니다'));
        return;
      }
      const perDecade = new Map();
      for (const s of shown) {
        const d = Math.floor(s.year / 10) * 10;
        perDecade.set(d, (perDecade.get(d) || 0) + 1);
      }
      const unit = this.mode === 'ost' ? '편' : '곡';
      const frag = document.createDocumentFragment();
      let decade = null;
      for (const s of shown) {
        const d = Math.floor(s.year / 10) * 10;
        if (d !== decade) {
          decade = d;
          const h = document.createElement('li');
          h.className = 'lib-decade';
          h.textContent = `${d}년대 · ${perDecade.get(d)}${unit}`;
          frag.append(h);
        }
        frag.append(this.buildRow(s));
      }
      this.el.list.replaceChildren(frag);
    }

    buildRow(s) {
      const li = document.createElement('li');
      li.className = 'lib-row';
      li.dataset.id = s.id;

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'lib-play';

      const main = document.createElement('div');
      main.className = 'lib-main';
      const line = document.createElement('div');
      line.className = 'lib-line1';
      const year = document.createElement('span');
      year.className = 'lib-year';
      year.textContent = s.year;
      const name = document.createElement('span');
      name.className = 'lib-name';
      line.append(year, name);
      main.append(line);

      if (this.mode === 'ost') {
        name.textContent = s.work;
        const type = document.createElement('span');
        type.className = 'lib-type';
        type.textContent = s.workType === 'drama' ? '드라마' : '영화';
        line.append(type);
        const song = document.createElement('div');
        song.className = 'lib-sub';
        song.textContent = `♪ ${s.artist ? `${s.artist} — ` : ''}${s.song || ''}`;
        main.append(song);
      } else {
        name.textContent = `${s.artist} — ${s.title}`;
      }

      const source = document.createElement('div');
      source.className = 'lib-sub lib-source';
      const note = document.createElement('input');
      note.type = 'text';
      note.className = 'text-input lib-note';
      note.maxLength = 200;
      note.placeholder = '무엇이 이상한가요? (선택) 예: 라이브 버전, 다른 곡, 연도 틀림';
      main.append(source, note);

      const actions = document.createElement('div');
      actions.className = 'lib-actions';
      for (const kind of ['recheck', 'remove']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lib-mark';
        b.dataset.kind = kind;
        b.textContent = KIND_LABEL[kind];
        actions.append(b);
      }

      li.append(play, main, actions);
      this.updateRow(li, s);
      return li;
    }

    updateRow(li, s) {
      const st = this.store.stateOf(this.mode, s.id);
      li.dataset.state = st;
      li.querySelectorAll('.lib-mark').forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.kind === st)));
      const note = li.querySelector('.lib-note');
      note.hidden = st !== 'recheck';
      if (st === 'recheck') note.value = this.store.of(this.mode).recheck[s.id]?.note || '';
      this.renderSource(li, s);
      this.renderPlay(li, s);
    }

    /** 게임에서 실제로 나갈 음원이 무엇인지 보여 준다. */
    renderSource(li, s) {
      const box = li.querySelector('.lib-source');
      const tag = document.createElement('span');
      if (s.spotifyUri) {
        tag.className = 'lib-src spotify';
        tag.textContent = 'Spotify';
        const info = this.resolver?.trackInfo?.(s);
        const link = document.createElement('a');
        link.className = 'lib-open';
        link.href = `https://open.spotify.com/track/${s.spotifyUri.split(':').pop()}`;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '열기';
        box.replaceChildren(tag, info
          ? `${info.artists} / ${info.name} · ${info.album}${info.year ? ` (${info.year})` : ''} `
          : '곡 정보 없음 ', link);
      } else {
        tag.className = 'lib-src preview';
        tag.textContent = '미리듣기';
        box.replaceChildren(tag,
          `30초 · ${s.itunesArtist || s.artist} / ${s.itunesTitle || ''} · ${s.album || ''}`);
      }
    }

    renderPlay(li, s) {
      const b = li.querySelector('.lib-play');
      const mine = this.playingId === s.id;
      li.classList.toggle('is-playing', mine && this.playState === 'playing');
      li.classList.toggle('is-loading', mine && this.playState === 'loading');
      // ▶ 가 이모지로 바뀌지 않도록 글자 표기를 고정한다
      b.textContent = !mine ? '▶︎' : this.playState === 'loading' ? '…' : '■︎';
      b.setAttribute('aria-label', mine ? '정지' : '듣기');
      b.title = s.spotifyUri && this.hooks.spotify()
        ? 'Spotify 로 듣기 (게임과 같은 음원)' : '30초 미리듣기로 듣기';
    }

    renderRequests() {
      const m = this.store.of(this.mode);
      const c = this.store.counts(this.mode);
      const here = c.add + c.recheck + c.remove;
      const total = this.store.total;
      this.el.reqSummary.textContent = total
        ? `요청 — 재검수 ${c.recheck} · 빼기 ${c.remove} · 추가 ${c.add}`
          + (total !== here ? `  (다른 모드 포함 ${total}건)` : '')
        : '요청 없음';
      this.el.save.disabled = total === 0;

      const note = this.el.saveNote;
      if (this.pruned) {
        note.textContent = `처리가 끝난 요청 ${this.pruned}건을 정리했습니다.`;
        note.className = 'field-note status-ok';
        this.pruned = 0;
      } else if (this.store.unsaved) {
        note.textContent = '저장하지 않은 요청이 있습니다. 이 기기에만 있으니 파일로 저장해 전달해 주세요.';
        note.className = 'field-note status-warn';
      } else if (total && this.store.data.savedAt) {
        note.textContent = `${clock(this.store.data.savedAt)} 에 저장함 · 처리가 끝나면 자동으로 사라집니다.`;
        note.className = 'field-note';
      } else {
        note.textContent = '듣다가 이상한 곡은 「재검수」, 뺄 곡은 「빼기」를 누르세요. '
          + '표시만 해 두고, 모아서 파일로 저장해 전달하면 한꺼번에 처리합니다.';
        note.className = 'field-note';
      }

      const items = [];
      const item = (kind, key, text, sub) => {
        const li = document.createElement('li');
        const tag = document.createElement('span');
        tag.className = `lib-tag ${kind}`;
        tag.textContent = KIND_LABEL[kind];
        const body = document.createElement('span');
        body.className = 'lib-req-body';
        body.textContent = text;
        if (sub) {
          const s = document.createElement('span');
          s.className = 'lib-req-sub';
          s.textContent = sub;
          body.append(s);
        }
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'lib-cancel';
        x.dataset.kind = kind;
        x.dataset.key = key;
        x.textContent = '취소';
        li.append(tag, body, x);
        items.push(li);
      };
      for (const a of m.add) {
        const year = a.year || '연도 모름';
        item('add', a.rid, this.mode === 'ost'
          ? `${year} ${a.work}${a.song ? ` — ${a.song}` : ''}${a.artist ? ` (${a.artist})` : ''}`
          : `${year} ${a.artist} — ${a.title}`, a.note);
      }
      for (const kind of ['recheck', 'remove']) {
        for (const [id, e] of Object.entries(m[kind])) {
          const d = this.songById(id) || e.song;
          const text = this.mode === 'ost' ? `${d.year} ${d.work}` : `${d.year} ${d.artist} — ${d.title}`;
          const sub = [e.note, this.songById(id) ? '' : '덱에서 바뀐 곡'].filter(Boolean).join(' · ');
          item(kind, id, text, sub);
        }
      }
      this.el.reqList.replaceChildren(...items);
    }

    renderAddForm() {
      const fields = this.mode === 'ost'
        ? [['work', '작품명', true, '예: 응답하라 1988'], ['song', '곡명', false, '모르면 비워 두세요'],
           ['artist', '가수', false, ''], ['year', '방영·개봉 연도', false, '모르면 비워 두세요'],
           ['note', '메모', false, '']]
        : [['artist', '가수', true, '예: 아이유'], ['title', '곡명', true, '예: 좋은 날'],
           ['year', '발표 연도', false, '모르면 비워 두세요'], ['note', '메모', false, '']];
      const nodes = fields.map(([name, label, required, placeholder]) => {
        const wrap = document.createElement('label');
        wrap.className = 'lib-field' + (name === 'note' ? ' wide' : '');
        const cap = document.createElement('span');
        cap.textContent = required ? `${label} *` : label;
        const input = document.createElement('input');
        input.className = 'text-input';
        input.name = name;
        input.placeholder = placeholder;
        input.required = required;
        input.maxLength = name === 'year' ? 4 : 120;
        if (name === 'year') input.inputMode = 'numeric';
        wrap.append(cap, input);
        return wrap;
      });
      const row = document.createElement('div');
      row.className = 'lib-add-actions';
      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.className = 'btn btn-secondary btn-sm';
      btn.textContent = '추가 요청에 넣기';
      const msg = document.createElement('span');
      msg.className = 'field-note lib-add-msg';
      row.append(btn, msg);
      this.el.addForm.replaceChildren(...nodes, row);
    }

    submitAdd() {
      const form = this.el.addForm;
      const v = Object.fromEntries([...new FormData(form)].map(([k, x]) => [k, String(x).trim()]));
      const msg = form.querySelector('.lib-add-msg');
      const say = (text, kind = '') => {
        msg.textContent = text;
        msg.className = 'field-note lib-add-msg' + (kind ? ` status-${kind}` : '');
      };

      let year = null;
      if (v.year) {
        year = Number(v.year);
        const max = new Date().getFullYear() + 1;
        if (!Number.isInteger(year) || year < 1900 || year > max) {
          say(`연도는 1900~${max} 사이 숫자로 적어 주세요. 모르면 비워 두세요.`, 'warn');
          return;
        }
      }
      const entry = this.mode === 'ost'
        ? { work: v.work, song: v.song, artist: v.artist, year, note: v.note }
        : { artist: v.artist, title: v.title, year, note: v.note };
      const dup = this.findDuplicate(entry);
      if (dup) { say(`이미 있습니다 — ${dup}`, 'warn'); return; }

      this.store.add(this.mode, entry);
      form.reset();
      say('추가 요청에 넣었습니다.', 'ok');
      this.afterChange();
    }

    findDuplicate(entry) {
      const pending = this.store.of(this.mode).add;
      if (this.mode === 'ost') {
        const w = norm(entry.work);
        const hit = this.songs().find((s) => norm(s.work) === w);
        if (hit) return `${hit.year} ${hit.work}`;
        return pending.some((a) => norm(a.work) === w) ? '추가 요청 목록에 있습니다' : null;
      }
      const a = norm(entry.artist);
      const t = norm(entry.title);
      const hit = this.songs().find((s) => norm(s.artist) === a
        && [s.title, s.alt, s.itunesTitle].some((x) => x && norm(x) === t));
      if (hit) return `${hit.year} ${hit.artist} — ${hit.title}`;
      return pending.some((p) => norm(p.artist) === a && norm(p.title) === t)
        ? '추가 요청 목록에 있습니다' : null;
    }

    refreshBadge() {
      const b = this.el.button;
      if (!b) return;
      const n = this.store.total;
      if (n) b.dataset.badge = n > 99 ? '99+' : String(n);
      else delete b.dataset.badge;
      b.classList.toggle('has-unsaved', this.store.unsaved);
    }

    // ---------- 듣기 ----------
    async togglePreview(song) {
      if (this.playingId === song.id) { this.stopPreview(); return; }
      this.stopPreview();
      this.hooks.beforePreview?.();

      const sp = this.hooks.spotify();
      const viaSpotify = Boolean(sp && song.spotifyUri);
      const p = viaSpotify ? sp : this.itunes;
      if (viaSpotify && !this._wired.has(sp)) {
        sp.on('ended', () => { if (this.previewPlayer === sp) this.stopPreview(); });
        this._wired.add(sp);
      }
      if (viaSpotify) this.usedSpotify = true;
      this.previewPlayer = p;
      this.playingId = song.id;
      this.playState = 'loading';
      this.refreshPlaying();

      try {
        if (!viaSpotify) this.itunes.volume = this.hooks.volume();
        await p.load(song);
        if (this.playingId !== song.id) return;          // 그 사이 다른 곡을 눌렀다
        await p.playFrom(0);
        if (this.playingId !== song.id) { p.stop(); return; }
        this.playState = 'playing';
      } catch (err) {
        if (this.playingId === song.id) {
          this.playingId = null;
          this.previewPlayer = null;
          this.playState = null;
        }
        this.toast(`재생하지 못했습니다 — ${err.message}`);
      }
      this.refreshPlaying(song.id);
    }

    stopPreview() {
      const p = this.previewPlayer;
      const id = this.playingId;
      this.previewPlayer = null;
      this.playingId = null;
      this.playState = null;
      if (p) { try { p.stop(); } catch (_) {} }
      if (id) this.refreshPlaying(id);
    }

    /** 재생 표시가 바뀐 줄만 고친다 */
    refreshPlaying(extraId) {
      const ids = new Set([this.playingId, this._lastPlaying, extraId].filter(Boolean));
      for (const id of ids) {
        const row = this.rowOf(id);
        const s = this.songById(id);
        if (row && s) this.renderPlay(row, s);
      }
      this._lastPlaying = this.playingId;
    }

    // ---------- 저장 ----------
    /** 처리하는 쪽이 덱을 다시 열어 보지 않아도 되도록 곡 정보를 함께 담는다. */
    describe(mode, s) {
      const info = this.resolver?.trackInfo?.(s);
      return {
        year: s.year,
        ...(mode === 'ost'
          ? { work: s.work, song: s.song, artist: s.artist }
          : { artist: s.artist, title: s.title }),
        play: s.spotifyUri ? 'spotify' : 'preview',
        spotifyUri: s.spotifyUri || null,
        spotify: info ? { name: info.name, artists: info.artists, album: info.album, year: info.year } : null,
        itunes: { title: s.itunesTitle, artist: s.itunesArtist, album: s.album, year: s.itunesYear },
      };
    }

    buildExport() {
      const out = {
        kind: 'music-game/requests',
        version: 1,
        exportedAt: now(),
        build: window.RESOLVER_BUILD || '',
      };
      for (const k of MODE_KEYS) {
        const m = this.store.of(k);
        const byId = this.index[k] || new Map();
        const marked = (kind) => Object.entries(m[kind]).map(([id, e]) => {
          const s = byId.get(id);
          return {
            rid: e.rid, at: e.at, id,
            ...(s ? this.describe(k, s) : { ...e.song, missing: true }),
            ...(e.note ? { note: e.note } : {}),
          };
        });
        out[k] = {
          deck: (this.decks[k] || []).length,
          add: m.add.map((a) => ({ ...a })),
          recheck: marked('recheck'),
          remove: marked('remove'),
        };
      }
      return out;
    }

    save() {
      if (!this.store.total) return;
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const name = `music-game-requests-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
        + `-${p(d.getHours())}${p(d.getMinutes())}.json`;
      const url = URL.createObjectURL(new Blob([JSON.stringify(this.buildExport(), null, 1)],
        { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      this.store.markSaved();
      this.renderRequests();
      this.refreshBadge();
      this.el.saveNote.textContent = `${name} 로 저장했습니다 (다운로드 폴더). 처리가 끝나면 표시가 자동으로 사라집니다.`;
      this.el.saveNote.className = 'field-note status-ok';
    }
  }

  window.RequestStore = RequestStore;
  window.SongLibrary = SongLibrary;
})();
