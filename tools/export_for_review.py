"""
교차검증용 목록을 뽑는다.

규칙을 다듬어 자동 매칭하는 방식은 한계가 분명하다. 규칙 하나를 고치면 다른 오탐이
생긴다(‘벨’→레드벨벳, ‘live’→Alive, 트랙명 허용→동명 트로트). 200여 개는 한 번
사람이 확인하면 끝나는 규모라, 검증하기 좋은 형태로 내보낸다.

사용법:
    python export_for_review.py            # OST (기본)
    python export_for_review.py --kpop
"""

import argparse
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def export_ost():
    data = json.load(open(os.path.join(ROOT, "data", "ost.json"), encoding="utf-8"))
    songs = data["songs"]

    txt = os.path.join(HERE, "verify_ost.txt")
    with open(txt, "w", encoding="utf-8") as f:
        f.write(f"한국 드라마 OST 검수 목록 — {len(songs)}개\n")
        f.write("=" * 78 + "\n\n")
        f.write("확인해야 할 것 세 가지\n")
        f.write("  1) 연도  — 드라마 첫 방영 연도가 맞는가\n")
        f.write("  2) 배역  — 배역 이름과 배우가 올바르게 짝지어졌는가 (남녀 주연)\n")
        f.write("  3) OST   — 그 드라마의 대표 OST 가 맞는가 (동명 다른 작품의 곡이 아닌가)\n\n")
        f.write("틀린 항목만 '번호 | 항목 | 올바른 값' 형태로 알려주면 됩니다.\n")
        f.write("=" * 78 + "\n\n")

        for i, s in enumerate(songs, 1):
            chars = " · ".join(
                f"{c['name']}({c['actor']})" if c.get("actor") else c["name"]
                for c in s.get("characters", [])
            )
            f.write(f"{i:3d}. {s['year']}  {s['work']}\n")
            f.write(f"     배역: {chars}\n")
            f.write(f"     OST : {s['artist']} — {s['song']}\n")
            f.write(f"     음원: {s['itunesArtist']} / {s['itunesTitle']}  [{s.get('album') or ''}]\n\n")

    csv_path = os.path.join(HERE, "verify_ost.csv")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["번호", "연도", "작품", "배역1", "배우1", "배역2", "배우2",
                    "OST가수", "OST곡", "실제매칭가수", "실제매칭곡", "앨범"])
        for i, s in enumerate(songs, 1):
            c = s.get("characters", []) + [{}, {}]
            w.writerow([i, s["year"], s["work"],
                        c[0].get("name", ""), c[0].get("actor", ""),
                        c[1].get("name", ""), c[1].get("actor", ""),
                        s["artist"], s["song"],
                        s.get("itunesArtist", ""), s.get("itunesTitle", ""),
                        s.get("album", "")])

    print(f"  {txt}")
    print(f"  {csv_path}")
    print(f"  총 {len(songs)}개")


def export_kpop():
    data = json.load(open(os.path.join(ROOT, "data", "kpop.json"), encoding="utf-8"))
    songs = data["songs"]
    csv_path = os.path.join(HERE, "verify_kpop.csv")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["번호", "발매연도", "가수", "곡", "실제매칭가수", "실제매칭곡", "앨범", "앨범연도"])
        for i, s in enumerate(songs, 1):
            w.writerow([i, s["year"], s["artist"], s["title"],
                        s.get("itunesArtist", ""), s.get("itunesTitle", ""),
                        s.get("album", ""), s.get("itunesYear", "")])
    print(f"  {csv_path}")
    print(f"  총 {len(songs)}곡")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--kpop", action="store_true")
    args = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    (export_kpop if args.kpop else export_ost)()
