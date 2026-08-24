"""
seed_songs.csv 의 큐레이션 목록을 iTunes Search API 와 대조해
앱이 사용할 data/songs.json 을 생성한다.

- 발매연도는 '시드에 적힌 큐레이션 값'을 정답으로 쓴다.
  iTunes releaseDate 는 편집앨범/리마스터에 오염되는 사례가 확인되어 교차검증용으로만 쓴다.
- 연도가 어긋나거나 매칭이 의심스러운 곡은 review_report.txt 로 따로 뽑아 사람이 확인한다.

iTunes Search API 는 분당 20회 수준의 제한이 있어 429/403 을 돌려준다.
따라서 요청 간격을 벌리고, 응답을 캐시에 남겨 재실행 시 이어서 받도록 했다.

사용법:
    python build_songs.py             # 수집 (캐시된 곡은 건너뜀)
    python build_songs.py --limit 20  # 앞 20곡만
    python build_songs.py --delay 4   # 요청 간격(초) 조정
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SEED_CSV = os.path.join(HERE, "seed_songs.csv")
CACHE = os.path.join(HERE, ".itunes_cache.json")
OUT_JSON = os.path.join(ROOT, "data", "songs.json")
REPORT = os.path.join(HERE, "review_report.txt")

SEARCH_URL = "https://itunes.apple.com/search"
DEFAULT_DELAY = 3.2      # 분당 ~19회. 실측상 이보다 빠르면 429 가 뜬다.
MAX_RETRY = 8
PROBE_INTERVAL = 60      # 차단 상태 재확인 간격(초)
MAX_BLOCK_WAIT = 5400    # 차단 해제를 기다리는 최대 시간(초)

# 편집/베스트 앨범은 원곡 발매일을 덮어써 연도를 오염시키므로 매칭 점수를 깎는다
COMPILATION_HINTS = [
    "best", "greatest", "collection", "golden", "original", "hits",
    "anthology", "remaster", "리마스터", "베스트", "골든", "모음", "전집",
]


def norm(s):
    """비교용 정규화: 소문자 + 괄호/특수문자 제거."""
    s = (s or "").lower()
    s = re.sub(r"\([^)]*\)", "", s)
    s = re.sub(r"\[[^\]]*\]", "", s)
    s = re.sub(r"[^0-9a-z가-힣]", "", s)
    return s


def similarity(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.85
    return len(set(a) & set(b)) / max(len(set(a)), len(set(b)))


def score_candidate(cand, artist, title):
    s = similarity(cand.get("trackName", ""), title) * 2.0
    s += similarity(cand.get("artistName", ""), artist) * 1.5
    album = (cand.get("collectionName") or "").lower()
    if any(h in album for h in COMPILATION_HINTS):
        s -= 0.4
    if not cand.get("previewUrl"):
        s -= 5.0
    return s


def load_cache():
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(CACHE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)


def _request(term):
    q = urllib.parse.urlencode({
        "term": term, "country": "kr", "media": "music",
        "entity": "song", "limit": 12,
    })
    req = urllib.request.Request(
        f"{SEARCH_URL}?{q}",
        headers={"User-Agent": "Mozilla/5.0 (music-game-deck-builder)"},
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8")).get("results", [])


def wait_until_unblocked(probe_interval=PROBE_INTERVAL, max_wait=MAX_BLOCK_WAIT):
    """
    IP 차단(403/429)은 곡 단위가 아니라 전체에 걸리므로, 곡마다 백오프하면
    남은 곡을 전부 헛되이 실패시킨다. 차단이 풀릴 때까지 한 자리에서 기다린다.
    """
    waited = 0
    while waited < max_wait:
        try:
            _request("test")
            if waited:
                print(f"      차단 해제됨 (총 {waited}초 대기)")
            return True
        except urllib.error.HTTPError as e:
            if e.code not in (429, 403):
                return True  # 다른 오류는 호출부에서 처리
        except Exception:
            pass
        print(f"      차단 지속 — {probe_interval}초 후 재확인 (누적 {waited}초)", flush=True)
        time.sleep(probe_interval)
        waited += probe_interval
    return False


def itunes_search(term, delay):
    """429/403 을 만나면 차단이 풀릴 때까지 기다렸다가 재시도한다."""
    for attempt in range(1, MAX_RETRY + 1):
        try:
            return _request(term)
        except urllib.error.HTTPError as e:
            if e.code in (429, 403) and attempt < MAX_RETRY:
                print(f"      제한 감지({e.code}) — 해제 대기 시작", flush=True)
                if not wait_until_unblocked():
                    raise RuntimeError("차단이 오래 지속되어 중단합니다")
                continue
            raise
        except Exception:
            if attempt < MAX_RETRY:
                time.sleep(5 * attempt)
                continue
            raise
    return []


def build(limit=None, delay=DEFAULT_DELAY):
    with open(SEED_CSV, encoding="utf-8") as f:
        seeds = list(csv.DictReader(f))
    if limit:
        seeds = seeds[:limit]

    cache = load_cache()
    songs, problems = [], []
    fetched = 0
    # 서로 다른 시드가 같은 트랙에 매칭되면 한 판에 같은 곡이 두 번 나온다.
    # 실제로 검색어를 잘못 지정해 겪은 적이 있어 수집 단계에서 막는다.
    claimed = {}

    for i, row in enumerate(seeds, 1):
        year = int(row["year"])
        artist = row["artist"].strip()
        title = row["title"].strip()
        term = (row.get("search") or "").strip() or f"{artist} {title}"

        if term in cache:
            results = cache[term]
            tag = "캐시"
        else:
            try:
                results = itunes_search(term, delay)
            except Exception as e:
                problems.append(f"[검색실패] {year} {artist} - {title}: {e}")
                print(f"  {i:3d}/{len(seeds)} [FAIL] {artist} - {title}  ({e})")
                continue
            cache[term] = results
            fetched += 1
            tag = "신규"
            if fetched % 10 == 0:
                save_cache(cache)
            time.sleep(delay)

        usable = [r for r in results if r.get("previewUrl")]
        if not usable:
            problems.append(f"[결과없음] {year} {artist} - {title} (검색어: {term})")
            print(f"  {i:3d}/{len(seeds)} [NONE] {artist} - {title}")
            continue

        # 이미 다른 곡이 가져간 트랙은 후보에서 제외하고 차선을 고른다
        ranked = sorted(usable, key=lambda c: score_candidate(c, artist, title), reverse=True)
        best = next((c for c in ranked if c["trackId"] not in claimed), None)
        if best is None:
            owner = claimed.get(ranked[0]["trackId"], "?")
            problems.append(
                f"[중복충돌] {year} {artist} - {title}\n"
                f"           후보 트랙이 모두 '{owner}' 에 이미 배정되어 제외했습니다."
            )
            print(f"  {i:3d}/{len(seeds)} [DUP ] {artist} - {title}")
            continue
        claimed[best["trackId"]] = f"{artist} - {title}"

        conf = score_candidate(best, artist, title)
        itunes_year = int(best["releaseDate"][:4])

        songs.append({
            "id": f"s{best['trackId']}",
            "year": year,                   # 큐레이션 확정 연도 (게임 정답)
            "title": title,                 # 화면 표기는 큐레이션 표기를 따른다
            "artist": artist,
            "itunesTrackId": best["trackId"],
            "itunesTitle": best.get("trackName"),
            "itunesArtist": best.get("artistName"),
            "itunesYear": itunes_year,
            "album": best.get("collectionName"),
            "previewUrl": best["previewUrl"],
            "artwork": (best.get("artworkUrl100") or "").replace("100x100", "300x300"),
            "spotifyUri": None,             # Spotify 엔진 추가 시 채운다
        })

        flags = []
        if abs(itunes_year - year) > 1:
            flags.append(f"연도차 iTunes {itunes_year} vs 시드 {year}")
        if conf < 2.0:
            flags.append(f"매칭 신뢰도 낮음 {conf:.2f}")
        if flags:
            problems.append(
                f"[확인필요] {year} {artist} - {title}\n"
                f"           매칭됨: {best.get('artistName')} - {best.get('trackName')}\n"
                f"           앨범  : {best.get('collectionName')} ({itunes_year})\n"
                f"           사유  : {', '.join(flags)}"
            )
        print(f"  {i:3d}/{len(seeds)} [{'!' if flags else ' '}OK] {artist} - {title} ({year}) [{tag}]")

    save_cache(cache)
    songs.sort(key=lambda s: (s["year"], s["artist"]))

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump({
            "version": 1,
            "source": "iTunes Search API (30초 미리듣기)",
            "note": "year 필드는 큐레이션 확정값이며 게임의 정답으로 사용된다.",
            "count": len(songs),
            "songs": songs,
        }, f, ensure_ascii=False, indent=1)

    with open(REPORT, "w", encoding="utf-8") as f:
        f.write(f"총 시드 {len(seeds)}곡 / 수집 성공 {len(songs)}곡 / 확인필요 {len(problems)}건\n")
        f.write("=" * 70 + "\n\n")
        f.write("\n".join(problems) if problems else "확인이 필요한 항목이 없습니다.\n")

    print("\n" + "=" * 60)
    print(f"수집 성공 : {len(songs)} / {len(seeds)} 곡  (신규 요청 {fetched}건)")
    print(f"확인 필요 : {len(problems)} 건  ->  tools/review_report.txt")
    if songs:
        dec = {}
        for s in songs:
            dec[s["year"] // 10 * 10] = dec.get(s["year"] // 10 * 10, 0) + 1
        print("연대 분포 : " + "  ".join(f"{d}s {c}곡" for d, c in sorted(dec.items())))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--delay", type=float, default=DEFAULT_DELAY)
    args = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    build(args.limit, args.delay)
