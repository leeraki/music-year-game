"""
곡이 비어 있는 OST 항목의 대표곡 후보를 iTunes 에서 찾아 보여준다.

작품의 대표 OST 를 기억에 의존해 적으면 틀리기 쉬워서, 실제 카탈로그를 조회해
고르기 위한 도구다. 결과를 보고 seed_ost.csv 의 song/artist 를 채운다.

사용법:
    python discover_ost.py            # 곡이 빈 항목만 조회
    python discover_ost.py --all      # 전부 조회
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(HERE, "seed_ost.csv")
CACHE = os.path.join(HERE, ".itunes_cache.json")
DELAY = 5.0

# OST 앨범에서 게임에 쓰기 어려운 트랙 (반주/스코어 조각/인터루드)
SKIP = ["inst", "instrumental", "반주", "narration", "나레이션", "score", "interlude"]


def load_cache():
    return json.load(open(CACHE, encoding="utf-8")) if os.path.exists(CACHE) else {}


def search(term, cache):
    if term in cache:
        return cache[term], True
    q = urllib.parse.urlencode({
        "term": term, "country": "kr", "media": "music",
        "entity": "song", "limit": 12,
    })
    req = urllib.request.Request(
        f"https://itunes.apple.com/search?{q}",
        headers={"User-Agent": "Mozilla/5.0 (music-game-ost-discover)"},
    )
    for _ in range(4):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                res = json.loads(r.read().decode("utf-8")).get("results", [])
            cache[term] = res
            json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
            time.sleep(DELAY)
            return res, False
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                print("      제한 감지 — 120초 대기", flush=True)
                time.sleep(120)
                continue
            raise
    return [], False


def main(do_all):
    cache = load_cache()
    with open(SEED, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    targets = [r for r in rows
               if do_all or not (r["song"].strip() and r["artist"].strip())]
    print(f"조회 대상 {len(targets)}개\n")

    for i, r in enumerate(targets, 1):
        work = r["work"]
        term = (r.get("search") or "").strip() or f"{work} OST"
        try:
            res, cached = search(term, cache)
        except Exception as e:
            print(f"{i:3d}. {r['year']} {work} — 오류: {e}")
            continue

        # OST 앨범에 속하고 미리듣기가 있는 트랙 위주로 추린다
        cands = [
            c for c in res
            if c.get("previewUrl")
            and not any(s in (c.get("trackName") or "").lower() for s in SKIP)
        ]
        ost_first = sorted(
            cands,
            key=lambda c: (
                0 if "ost" in (c.get("collectionName") or "").lower()
                     or work.replace(" ", "") in (c.get("collectionName") or "").replace(" ", "")
                else 1,
                -(c.get("trackCount") or 0),
            ),
        )

        print(f"{i:3d}. {r['year']} {r['type']:5} {work}  {'(캐시)' if cached else ''}")
        if not ost_first:
            print("       후보 없음")
        for c in ost_first[:4]:
            print(f"       {c['artistName'][:18]:<18} | {c['trackName'][:30]:<30} | "
                  f"{(c.get('collectionName') or '')[:28]}")
        print()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--all", action="store_true")
    args = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    main(args.all)
