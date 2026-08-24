"""
곡 목록 검수 페이지를 만든다.

242곡을 하나씩 눌러 들어 보며 '이 곡이 맞나'를 눈과 귀로 확인하기 위한 도구다.
'젝스키스 폼생폼사'가 다른 가수의 동명이곡으로 매칭된 적이 있어, 자동 점검만으로는
부족하다는 게 드러났다.

사용법:
    python make_review_page.py      # tools/review.html 생성
"""

import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SONGS = os.path.join(os.path.dirname(HERE), "data", "songs.json")
OUT = os.path.join(HERE, "review.html")

sys.path.insert(0, HERE)
from audit_songs import artist_matches, norm, load_alt_map  # noqa: E402

ALT_MAP = load_alt_map()

VARIANT_HINTS = ["live", "remix", "acoustic", "inst", "ver.", "version",
                 "라이브", "리믹스", "어쿠스틱", "재녹음"]


def classify(s):
    """검수 우선순위를 매긴다. bad 가 먼저 눈에 띄어야 한다."""
    reasons = []
    if artist_matches(s["artist"], s.get("itunesArtist", "")) < 0.34:
        reasons.append(f"가수 불일치 → {s.get('itunesArtist')}")

    def same(x, y):
        a, b = norm(x), norm(y)
        return bool(a) and bool(b) and (a == b or a in b or b in a)
    alt = ALT_MAP.get((s["artist"].strip(), s["title"].strip()))
    if not (same(s["title"], s.get("itunesTitle", "")) or (alt and same(alt, s.get("itunesTitle", "")))):
        reasons.append(f"제목 다름 → {s.get('itunesTitle')}")

    blob = f"{s.get('itunesTitle', '')} {s.get('album', '')}".lower()
    if any(h in blob for h in VARIANT_HINTS):
        reasons.append("라이브/리믹스 의심")

    gap = abs(s.get("itunesYear", s["year"]) - s["year"])
    if gap > 3:
        reasons.append(f"연도 {gap}년 차 (iTunes {s.get('itunesYear')})")

    if any("불일치" in r or "다름" in r for r in reasons):
        return "bad", reasons
    if reasons:
        return "warn", reasons
    return "ok", reasons


def build():
    data = json.load(open(SONGS, encoding="utf-8"))
    songs = data["songs"]

    rows, counts = [], {"bad": 0, "warn": 0, "ok": 0}
    for s in songs:
        level, reasons = classify(s)
        counts[level] += 1
        e = lambda v: html.escape(str(v or ""))
        rows.append(f"""
    <tr class="{level}" data-level="{level}">
      <td class="yr">{s['year']}</td>
      <td>
        <div class="seed">{e(s['artist'])} — {e(s['title'])}</div>
        <div class="matched">{e(s.get('itunesArtist'))} — {e(s.get('itunesTitle'))}</div>
        <div class="album">{e(s.get('album'))} ({s.get('itunesYear')})</div>
        {''.join(f'<div class="flag">{e(r)}</div>' for r in reasons)}
      </td>
      <td class="play">
        <audio preload="none" controls src="{e(s['previewUrl'])}"></audio>
      </td>
    </tr>""")

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
  tr.bad  {{ background:rgba(255,92,108,.10); }}
  tr.warn {{ background:rgba(255,190,60,.07); }}
  tr.warn .flag {{ color:#ffbe3c; }}
  .play {{ width:290px; text-align:right; }}
  audio {{ width:280px; height:34px; }}
</style></head><body>
<h1>곡 목록 검수 — 총 {len(songs)}곡</h1>
<div class="sub">
  위 줄이 <b>덱에 표시될 정보</b>, 아래 회색 줄이 <b>실제 매칭된 음원</b>입니다.
  재생해 보고 다른 곡이면 <code>tools/seed_songs.csv</code> 의 검색어를 고쳐 다시 수집하세요.
</div>
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
  // 한 번에 한 곡만 나오게 한다
  document.addEventListener('play', e => {{
    document.querySelectorAll('audio').forEach(a => {{ if (a !== e.target) a.pause(); }});
  }}, true);
</script>
</body></html>"""

    open(OUT, "w", encoding="utf-8").write(doc)
    print(f"검수 페이지 생성: {OUT}")
    print(f"  교체 필요 {counts['bad']}곡 / 확인 권장 {counts['warn']}곡 / 정상 {counts['ok']}곡")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    build()
