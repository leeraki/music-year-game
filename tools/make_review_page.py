"""
곡 목록 검수 페이지를 만든다.

242곡을 하나씩 눌러 들어 보며 '이 곡이 맞나'를 눈과 귀로 확인하기 위한 도구다.
'젝스키스 폼생폼사'가 다른 가수의 동명이곡으로 매칭된 적이 있어, 자동 점검만으로는
부족하다는 게 드러났다.

사용법:
    python make_review_page.py      # tools/review.html 생성
"""

import csv
import datetime
import html
import json
import re
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODE = "ost" if "--ost" in sys.argv else "kpop"
SONGS = os.path.join(os.path.dirname(HERE), "data", f"{MODE}.json")
# 배포에 포함해 폰·태블릿에서도 열 수 있게 한다
OUT = os.path.join(os.path.dirname(HERE), "review", f"{MODE}.html")

sys.path.insert(0, HERE)
from audit_songs import artist_matches, norm, load_alt_map  # noqa: E402

ALT_MAP = load_alt_map()

# 단어 단위로 본다. 문자열로 훑었더니 빅뱅의 음반 'Alive' 가 live 로 걸렸다.
# 한국 곡이므로 'Korean Ver.' 만 원반 표기다. 일본어판은 번안 재녹음이라 걸러야 한다.
LANG_VER_RE = re.compile(r"korean\s*(ver\.|version)", re.I)

VARIANT_RE = re.compile(
    r"(?<![a-z])(live|remix|acoustic|inst|ver\.|version|concert|mixed|mix)(?![a-z])"
    r"|(?<![가-힣])(라이브|리믹스|어쿠스틱|재녹음)(?![가-힣])", re.I)


def classify(s):
    """검수 우선순위를 매긴다. bad 가 먼저 눈에 띄어야 한다."""
    reasons = []
    if MODE == "kpop" and artist_matches(s["artist"], s.get("itunesArtist", "")) < 0.34:
        reasons.append(f"가수 불일치 → {s.get('itunesArtist')}")

    def same(x, y):
        a, b = norm(x), norm(y)
        return bool(a) and bool(b) and (a == b or a in b or b in a)
    seed_title = s.get("song") or s.get("title") or ""
    alt = ALT_MAP.get((s["artist"].strip(), seed_title.strip()))
    itunes_title = s.get("itunesTitle", "")
    album_only = norm(itunes_title) == norm((s.get("album") or "").replace(" - Single", ""))
    if not (same(seed_title, itunes_title) or (alt and same(alt, itunes_title))):
        # 싱글 한 장에 곡명 없이 음반명만 붙은 OST 가 있다. 음원은 맞으니 확인만 권한다.
        reasons.append("곡명 없이 음반명뿐" if album_only else f"제목 다름 → {itunes_title}")

    blob = f"{s.get('itunesTitle', '')} {s.get('album', '')}"
    # 'Korean Version' 은 언어판 표기라 오히려 원반이다. 변형으로 보면 안 된다.
    blob = LANG_VER_RE.sub(" ", blob)
    if VARIANT_RE.search(blob):
        reasons.append("라이브/리믹스 의심")

    gap = abs(s.get("itunesYear", s["year"]) - s["year"]) if MODE == "kpop" else 0
    if gap > 2:                       # 3년으로 두었더니 재발매판 둘이 빠져나갔다
        reasons.append(f"연도 {gap}년 차 (iTunes {s.get('itunesYear')})")

    if any("불일치" in r or "다름" in r for r in reasons):
        return "bad", reasons
    if reasons:
        return "warn", reasons
    return "ok", reasons


_CHO = "g kk n d tt r m b pp s ss  j jj ch k t p h".split(" ")
_JUNG = ("a ae ya yae eo e yeo ye o wa wae oe yo u wo we wi yu eu ui i").split(" ")
_JONG = ["", "k", "k", "k", "n", "n", "n", "t", "l", "l", "l", "l", "l", "l",
         "l", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"]


def romanize(text):
    out = []
    for ch in text:
        code = ord(ch) - 0xAC00
        if 0 <= code < 11172:
            out.append(_CHO[code // 588] + _JUNG[(code % 588) // 28] + _JONG[code % 28])
        else:
            out.append(ch)
    return "".join(out)


def canon(text):
    """표기가 갈려도 같은 소리면 같은 글자로 모은다."""
    t = re.sub(r"[^a-z]", "", romanize(text or "").lower())
    for a, b in (("oo", "u"), ("ou", "u"), ("ee", "i"), ("eo", "u"),
                 ("eu", "u"), ("ae", "e"), ("ch", "c"), ("j", "c")):
        t = t.replace(a, b)
    for group, rep in (("gk", "k"), ("dt", "t"), ("bp", "p"), ("rl", "l")):
        t = re.sub(f"[{group}]", rep, t)
    return t


def dice(a, b):
    ga = {a[i:i + 2] for i in range(len(a) - 1)}
    gb = {b[i:i + 2] for i in range(len(b) - 1)}
    return 2 * len(ga & gb) / (len(ga) + len(gb)) if ga and gb else 0.0


def find_twins(songs):
    """로마자 표기가 갈려 같은 곡이 두 번 들어간 것을 찾는다(Roly Poly / 롤리폴리)."""
    twins, by_artist = set(), {}
    for s in songs:
        by_artist.setdefault(s["artist"], []).append(s)
    for group in by_artist.values():
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                ka = canon(a.get("title") or a.get("song") or "")
                kb = canon(b.get("title") or b.get("song") or "")
                if not ka or not kb:
                    continue
                # 짧은 제목은 우연히 겹친다. 「U」 가 「로꾸거」 안에 들어가 걸렸었다.
                if ka == kb or (min(len(ka), len(kb)) >= 4 and dice(ka, kb) >= 0.55):
                    twins.add(id(a))
                    twins.add(id(b))
    return twins


def write_csv(songs, stamp):
    """외부 도구로 전수 대조할 수 있게 같은 내용을 표로 내보낸다."""
    path = os.path.join(os.path.dirname(OUT), f"{MODE}.csv")
    if MODE == "ost":
        head = ["번호", "첫방영연도", "작품", "배역", "배우", "곡명",
                "가수", "iTunes가수", "iTunes곡명", "음반", "음반연도", "판"]
    else:
        head = ["번호", "발표연도", "가수", "곡명", "병기",
                "iTunes가수", "iTunes곡명", "음반", "음반연도", "판"]
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(head)
        for i, s in enumerate(songs, 1):
            common = [s.get("itunesArtist", ""), s.get("itunesTitle", ""),
                      s.get("album", ""), s.get("itunesYear", ""), stamp]
            if MODE == "ost":
                chars = s.get("characters") or []
                w.writerow([i, s["year"], s.get("work", ""),
                            " · ".join(c.get("name", "") for c in chars),
                            " · ".join(c.get("actor", "") for c in chars),
                            s.get("song", ""), s.get("artist", "")] + common)
            else:
                w.writerow([i, s["year"], s["artist"], s["title"],
                            s.get("alt") or ""] + common)
    return path


def build():
    data = json.load(open(SONGS, encoding="utf-8"))
    songs = data["songs"]

    twins = find_twins(songs)

    rows, counts = [], {"bad": 0, "warn": 0, "ok": 0}
    for s in songs:
        level, reasons = classify(s)
        if id(s) in twins:                # 같은 가수·같은 해 → 같은 곡이 두 번일 수 있다
            reasons.append("같은 가수·같은 해가 둘 — 중복 여부 확인")
            level = "warn" if level == "ok" else level
        counts[level] += 1
        e = lambda v: html.escape(str(v or ""))
        if MODE == "ost":
            # OST 검수에서 가장 확인이 필요한 건 배역 이름이다. 게임에서 정답으로
            # 읽어주는 값이라 곡 매칭보다 먼저 눈에 들어와야 한다.
            kind = "드라마" if s.get("workType") == "drama" else "영화"
            chars = " · ".join(
                f"<b>{e(c['name'])}</b>" + (f" <span class='actor'>({e(c['actor'])})</span>" if c.get("actor") else "")
                for c in s.get("characters", [])
            ) or "<span class='flag'>배역 없음</span>"
            head = f"""
        <div class="seed"><span class="kind">{kind}</span> {e(s['work'])}</div>
        <div class="chars">{chars}</div>
        <div class="matched">OST · {e(s.get('itunesArtist'))} — {e(s.get('itunesTitle'))}</div>
        <div class="album">{e(s.get('album'))}</div>"""
        else:
            head = f"""
        <div class="seed">{e(s['artist'])} — {e(s['title'])}</div>
        <div class="matched">{e(s.get('itunesArtist'))} — {e(s.get('itunesTitle'))}</div>
        <div class="album">{e(s.get('album'))} ({s.get('itunesYear')})</div>"""

        rows.append(f"""
    <tr class="{level}" data-level="{level}">
      <td class="yr">{s['year']}</td>
      <td>{head}
        {''.join(f'<div class="flag">{e(r)}</div>' for r in reasons)}
      </td>
      <td class="play">
        <audio preload="none" controls src="{e(s['previewUrl'])}"></audio>
      </td>
    </tr>""")

    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    doc = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>곡 목록 검수 — {len(songs)}곡</title>
<style>
  body {{ font-family: 'Malgun Gothic', system-ui, sans-serif; background:#12102a; color:#eee;
         margin:0; padding:24px; }}
  h1 {{ font-size:20px; margin:0 0 6px; }}
  .sub {{ color:#9a93c4; font-size:13px; margin-bottom:18px; }}
  .filters {{ display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; }}
  .filters button {{ padding:9px 16px; border-radius:99px; border:1px solid #322c5f;
                     background:transparent; color:#9a93c4; cursor:pointer; font-size:13px;
                     font-weight:600; font-family:inherit; }}
  .filters button.on {{ background:#ff3d81; border-color:#ff3d81; color:#fff; }}
  table {{ width:100%; border-collapse:collapse; }}
  td {{ border-bottom:1px solid #241f4d; padding:11px 8px; vertical-align:middle; }}
  .yr {{ width:58px; font-weight:800; font-size:17px; color:#ff8ab4; }}
  .seed {{ font-weight:700; font-size:15px; }}
  .matched {{ color:#9a93c4; font-size:13px; margin-top:2px; }}
  .album {{ color:#5b5390; font-size:11px; margin-top:2px; }}
  .flag {{ color:#ff5c6c; font-size:12px; margin-top:4px; font-weight:600; }}
  .kind {{ display:inline-block; font-size:11px; font-weight:700; color:#0e0c1f;
           background:#ff8ab4; border-radius:4px; padding:2px 7px; margin-right:7px;
           vertical-align:2px; }}
  .chars {{ font-size:17px; margin-top:6px; color:#fff; }}
  .chars .actor {{ color:#9a93c4; font-size:14px; font-weight:400; }}
  tr.bad  {{ background:rgba(255,92,108,.10); }}
  tr.warn {{ background:rgba(255,190,60,.07); }}
  tr.warn .flag {{ color:#ffbe3c; }}
  .stamp {{ color:#7f7aa0; font-size:13px; margin:-8px 0 14px; }}
  .play {{ width:290px; text-align:right; }}
  audio {{ width:280px; height:34px; }}
</style></head><body>
<h1>{'OST 검수 — 배역 이름 확인용' if MODE == 'ost' else '곡 목록 검수'} — 총 {len(songs)}{'개' if MODE == 'ost' else '곡'}</h1>
<div class="stamp">{stamp} 판 · 이보다 오래된 사본은 이미 고친 곳이 남아 있습니다</div>
<div class="sub" id="sub"></div>
<div class="filters">
  <button class="on" data-f="all">전체 {len(songs)}</button>
  <button data-f="bad">교체 필요 {counts['bad']}</button>
  <button data-f="warn">확인 권장 {counts['warn']}</button>
  <button data-f="ok">정상 {counts['ok']}</button>
</div>
<table><tbody>{''.join(rows)}</tbody></table>
<script>
  document.querySelectorAll('.filters button').forEach(b => b.onclick = () => {{
    document.querySelectorAll('.filters button').forEach(x => x.classList.toggle('on', x === b));
    const f = b.dataset.f;
    document.querySelectorAll('tbody tr').forEach(tr => {{
      tr.style.display = (f === 'all' || tr.dataset.level === f) ? '' : 'none';
    }});
  }});
  document.getElementById('sub').innerHTML = {json.dumps(
    "굵은 글씨가 <b>극중 배역 이름</b>, 괄호가 배우입니다. 게임에서 이 값을 정답으로 읽어줍니다. "
    "틀린 배역이 있으면 <b>연도와 작품명</b>을 알려주시면 고치겠습니다. "
    "아래 회색 줄은 실제 매칭된 음원이니 재생해 보고 다른 곡이면 함께 알려주세요."
    if MODE == "ost" else
    "위 줄이 <b>덱에 표시될 정보</b>, 아래 회색 줄이 <b>실제 매칭된 음원</b>입니다. "
    "재생해 보고 다른 곡이면 알려주세요."
)};

  // 한 번에 한 곡만 나오게 한다
  document.addEventListener('play', e => {{
    document.querySelectorAll('audio').forEach(a => {{ if (a !== e.target) a.pause(); }});
  }}, true);
</script>
</body></html>"""

    open(OUT, "w", encoding="utf-8").write(doc)
    csv_path = write_csv(songs, stamp)
    print(f"검수 페이지 생성: {OUT}")
    print(f"      대조용 표: {csv_path}")
    print(f"  교체 필요 {counts['bad']}곡 / 확인 권장 {counts['warn']}곡 / 정상 {counts['ok']}곡")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    build()
