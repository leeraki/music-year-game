# -*- coding: utf-8 -*-
"""시드에 있는데 덱에 없는 곡만 찾아 덱에 덧붙인다.

전체를 다시 빌드하면 손으로 골라 둔 음원과 박아 둔 Spotify 주소가 사라진다
(김완선 「삐에로」 의 1990년 원반, 핑클 「루비」 의 데뷔 음반 판 등). 이미
있는 곡은 건드리지 않고 새 곡만 붙인다.

사용법:
    python build_new_kpop.py [--delay 5]
"""
import argparse
import csv
import json
import os
import re
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import build_songs as bs  # noqa: E402

OUT = os.path.join(ROOT, "data", "kpop.json")
REPORT = os.path.join(HERE, "new_kpop_report.txt")


def norm(s):
    return re.sub(r"[^0-9a-z가-힣]", "", (s or "").lower())


def main(delay):
    data = json.load(open(OUT, encoding="utf-8"))
    songs = data["songs"]
    have = {(norm(s["artist"]), norm(s["title"])) for s in songs}
    claimed = {s["itunesTrackId"] for s in songs}

    seed = list(csv.DictReader(open(os.path.join(HERE, "seed_kpop.csv"), encoding="utf-8")))
    todo = [r for r in seed if (norm(r["artist"]), norm(r["title"])) not in have]
    print("덱 {}곡 · 새로 찾을 곡 {}곡".format(len(songs), len(todo)), flush=True)

    cache = bs.load_cache()
    added, problems, fetched = 0, [], 0
    for i, row in enumerate(todo, 1):
        year = int(row["year"])
        artist, title = row["artist"].strip(), row["title"].strip()
        alt = (row.get("alt") or "").strip() or None
        term = (row.get("search") or "").strip() or "{} {}".format(artist, title)

        if term in cache:
            results = cache[term]
        else:
            try:
                results = bs.itunes_search(term, delay)
            except Exception as e:
                problems.append("[검색실패] {} {} — {}: {}".format(year, artist, title, e))
                print("  {:3d}/{} [FAIL] {} — {}".format(i, len(todo), artist, title), flush=True)
                continue
            cache[term] = results
            fetched += 1
            if fetched % 10 == 0:
                bs.save_cache(cache)
            time.sleep(delay)

        usable = [c for c in results if c.get("previewUrl")]
        score = lambda c: bs.score_candidate(c, artist, title, year, alt)
        ranked = sorted(usable, key=score, reverse=True)
        best = next((c for c in ranked
                     if c["trackId"] not in claimed and score(c) > 0), None)
        if best is None:
            top = ranked[0] if ranked else None
            problems.append("[매칭실패] {} {} — {}\n           최상위: {} / {}".format(
                year, artist, title,
                top.get("artistName") if top else "없음",
                top.get("trackName") if top else "없음"))
            print("  {:3d}/{} [MISS] {} — {}".format(i, len(todo), artist, title), flush=True)
            continue

        claimed.add(best["trackId"])
        have.add((norm(artist), norm(title)))
        ay = int((best.get("releaseDate") or "0")[:4] or 0)
        songs.append({
            "id": "s{}".format(best["trackId"]), "year": year,
            "title": title, "alt": alt, "artist": artist,
            "itunesTrackId": best["trackId"], "itunesTitle": best.get("trackName"),
            "itunesArtist": best.get("artistName"), "album": best.get("collectionName"),
            "itunesYear": ay, "previewUrl": best["previewUrl"],
            "artwork": (best.get("artworkUrl100") or "").replace("100x100", "300x300"),
            "spotifyUri": None,
        })
        added += 1
        gap = abs(ay - year) if ay else 0
        flag = " ← 음반 {}년, {}년 차".format(ay, gap) if gap > 2 else ""
        if flag:
            problems.append("[연도확인] {} {} — {} : 음반 {}년".format(year, artist, title, ay))
        print("  {:3d}/{} [OK] {} — {}{}".format(i, len(todo), artist, title, flag), flush=True)

    bs.save_cache(cache)
    songs.sort(key=lambda s: (s["year"], s["artist"], s["title"]))
    data["count"] = len(songs)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)
    open(REPORT, "w", encoding="utf-8").write("\n".join(problems) or "확인할 것 없음\n")
    print("\n{}곡 추가 → 총 {}곡 · 확인 필요 {}건 → tools/new_kpop_report.txt".format(
        added, len(songs), len(problems)))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--delay", type=float, default=bs.DEFAULT_DELAY)
    a = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    main(a.delay)
