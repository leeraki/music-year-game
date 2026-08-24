"""
seed_ost.csv 를 iTunes 와 대조해 data/ost.json 을 만든다.

K-POP 모드와 정답이 다르다.
  K-POP : 노래의 발매 연도 / 가수 / 곡 제목
  OST   : 작품의 출시 연도 (영화=개봉, 드라마=첫 방영) / 작품 제목 / 주연 배역 이름

따라서 year 는 '작품의 연도'이며, 곡의 발매 연도와 다를 수 있다(재발매 OST 앨범 등).
그래서 build_songs.py 와 달리 연도 근접 가산점을 주지 않는다.

매칭 규칙(가수 일치 필수, 라이브·리믹스 배제 등)은 build_songs.py 의 것을 그대로 쓴다.

사용법:
    python build_ost.py
    python build_ost.py --cache-only
"""

import argparse
import csv
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SEED = os.path.join(HERE, "seed_ost.csv")
OUT_JSON = os.path.join(ROOT, "data", "ost.json")
REPORT = os.path.join(HERE, "review_report_ost.txt")

sys.path.insert(0, HERE)
import build_songs as bs  # noqa: E402


def split_pipe(s):
    return [p.strip() for p in (s or "").split("|") if p.strip()]


def score_ost(cand, artist, song, alt=None):
    """
    OST 전용 채점.

    K-POP 과 두 가지가 다르다.
      - 연도 가산점을 주지 않는다. 여기서 year 는 작품의 연도라 곡 발매일과 무관하다.
      - 가수 불일치를 바로 탈락시키지 않는다. iTunes 한국은 외국 아티스트를 한글로
        옮겨 적는 일이 많아('John Williams' → '존 윌리엄스') 표기만으로는 판단할 수 없다.
        대신 제목이 확실히 맞을 때만 통과시키고 점수를 깎는다.
    """
    if not cand.get("previewUrl"):
        return -99.0

    t = bs.title_similarity(cand.get("trackName", ""), song, alt)
    if t < 0.34:
        return -30.0

    s = t * 3.0
    if not bs.artist_ok(artist, cand.get("artistName", "")):
        if t < 0.8:
            return -20.0          # 제목도 애매하면 다른 곡으로 본다
        s -= 1.0

    album = (cand.get("collectionName") or "").lower()
    if any(h in album for h in bs.COMPILATION_HINTS):
        s -= 1.2
    if bs.is_variant(cand):
        s -= 3.0
    # 사운드트랙 음반이면 그 작품의 음원일 가능성이 높다
    if "ost" in album or "soundtrack" in album or "original motion picture" in album:
        s += 1.5
    return s


def build(cache_only=False, delay=bs.DEFAULT_DELAY):
    with open(SEED, encoding="utf-8") as f:
        seeds = list(csv.DictReader(f))

    cache = bs.load_cache()
    items, problems = [], []
    claimed, fetched, skipped = {}, 0, 0

    for i, row in enumerate(seeds, 1):
        year = int(row["year"])
        work = row["work"].strip()
        song = row["song"].strip()
        artist = row["artist"].strip()
        alt = (row.get("alt") or "").strip() or None
        term = (row.get("search") or "").strip() or f"{artist} {song}"

        if term in cache:
            results = cache[term]
        elif cache_only:
            skipped += 1
            continue
        else:
            try:
                results = bs.itunes_search(term, delay)
            except Exception as e:
                problems.append(f"[검색실패] {year} {work} — {artist} / {song}: {e}")
                print(f"  {i:3d}/{len(seeds)} [FAIL] {work}  ({e})")
                continue
            cache[term] = results
            fetched += 1
            if fetched % 10 == 0:
                bs.save_cache(cache)
            time.sleep(delay)

        usable = [r for r in results if r.get("previewUrl")]
        if not usable:
            problems.append(f"[결과없음] {year} {work} (검색어: {term})")
            print(f"  {i:3d}/{len(seeds)} [NONE] {work}")
            continue

        score = lambda c: score_ost(c, artist, song, alt)
        ranked = sorted(usable, key=score, reverse=True)
        best = next((c for c in ranked
                     if c["trackId"] not in claimed and score(c) > 0), None)
        if best is None:
            top = ranked[0] if ranked else None
            problems.append(
                f"[매칭실패] {year} {work} — {artist} / {song}\n"
                f"           최상위 후보: {top.get('artistName') if top else '없음'} - "
                f"{top.get('trackName') if top else '없음'}"
            )
            print(f"  {i:3d}/{len(seeds)} [MISS] {work} — {artist} / {song}")
            continue
        claimed[best["trackId"]] = work

        chars = split_pipe(row["characters"])
        actors = split_pipe(row["actors"])
        items.append({
            "id": f"o{best['trackId']}",
            "year": year,                       # 작품의 출시 연도 (게임 정답)
            "work": work,
            "workType": row["type"].strip(),    # movie | drama
            "characters": [
                {"name": c, "actor": actors[j] if j < len(actors) else ""}
                for j, c in enumerate(chars)
            ],
            "song": song,
            "artist": artist,
            "itunesTrackId": best["trackId"],
            "itunesTitle": best.get("trackName"),
            "itunesArtist": best.get("artistName"),
            "album": best.get("collectionName"),
            "previewUrl": best["previewUrl"],
            "artwork": (best.get("artworkUrl100") or "").replace("100x100", "300x300"),
            "spotifyUri": None,
        })

        flags = []
        if bs.is_variant(best):
            flags.append("라이브/리믹스 의심")
        if not chars:
            flags.append("배역 이름 없음")
        if flags:
            problems.append(f"[확인필요] {year} {work} — {best.get('trackName')}: {', '.join(flags)}")
        print(f"  {i:3d}/{len(seeds)} [{'!' if flags else ' '}OK] {work} ({year}) — "
              f"{best.get('artistName')} / {best.get('trackName')}")

    bs.save_cache(cache)
    items.sort(key=lambda s: (s["year"], s["work"]))

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump({
            "version": 1,
            "mode": "ost",
            "source": "iTunes Search API (30초 미리듣기)",
            "note": "year 는 작품의 출시 연도(영화=개봉, 드라마=첫 방영)이며 게임의 정답이다.",
            "count": len(items),
            "songs": items,
        }, f, ensure_ascii=False, indent=1)

    with open(REPORT, "w", encoding="utf-8") as f:
        f.write(f"시드 {len(seeds)}개 / 수집 {len(items)}개 / 확인필요 {len(problems)}건\n")
        f.write("=" * 70 + "\n\n")
        f.write("\n".join(problems) if problems else "확인이 필요한 항목이 없습니다.\n")

    print("\n" + "=" * 60)
    print(f"수집 성공 : {len(items)} / {len(seeds)} 개"
          + (f"  (캐시없어 건너뜀 {skipped})" if skipped else ""))
    print(f"확인 필요 : {len(problems)} 건  ->  tools/review_report_ost.txt")
    if items:
        from collections import Counter
        c = Counter(x["workType"] for x in items)
        d = Counter(x["year"] // 10 * 10 for x in items)
        print(f"유형      : 드라마 {c['drama']} / 영화 {c['movie']}")
        print("연대 분포 : " + "  ".join(f"{k}s {v}" for k, v in sorted(d.items())))
        no_char = sum(1 for x in items if not x["characters"])
        print(f"배역 정보 : {len(items) - no_char}개 있음 / {no_char}개 없음")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--cache-only", action="store_true")
    p.add_argument("--delay", type=float, default=bs.DEFAULT_DELAY)
    args = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    build(args.cache_only, args.delay)
