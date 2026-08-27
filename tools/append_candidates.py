# -*- coding: utf-8 -*-
"""후보 목록에서 덱에 없는 곡만 골라 시드에 붙인다.

이미 있는 곡, 시드에 적어만 두고 매칭에 실패한 곡을 다시 넣지 않도록 거른다.

사용법:
    python append_candidates.py            # 무엇이 붙을지 보여주기만 한다
    python append_candidates.py --write    # 실제로 시드에 붙인다
"""
import csv
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from candidates_kpop import CANDIDATES as C1  # noqa: E402
from candidates_kpop2 import CANDIDATES as C2  # noqa: E402
from candidates_kpop3 import CANDIDATES as C3  # noqa: E402

# 빈 제목은 초안에서 실수로 남은 자리다. 그대로 두면 아무 곡이나 걸린다.
CANDIDATES = [c for c in (C1 + C2 + C3) if c[2].strip()]


def norm(s):
    return re.sub(r"[^0-9a-z가-힣]", "", (s or "").lower())


def main(write=False):
    seed_path = os.path.join(HERE, "seed_kpop.csv")
    rows = list(csv.DictReader(open(seed_path, encoding="utf-8")))
    have = {(norm(r["artist"]), norm(r["title"])) for r in rows}

    add, dup = [], []
    for year, artist, title in CANDIDATES:
        key = (norm(artist), norm(title))
        if key in have:
            dup.append((year, artist, title))
            continue
        have.add(key)
        add.append({"year": str(year), "artist": artist, "title": title,
                    "search": "", "alt": ""})

    print("후보 {}곡 · 새로 붙일 것 {}곡 · 이미 있음 {}곡".format(
        len(CANDIDATES), len(add), len(dup)))
    for y, a, t in dup:
        print("   [중복] {} {} — {}".format(y, a, t))
    if not write:
        print("\n(--write 를 붙이면 실제로 시드에 씁니다)")
        return

    rows.extend(add)
    fd, tmp = tempfile.mkstemp(dir=HERE, suffix=".csv")
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, seed_path)
    print("\n시드 {}줄 → {}줄".format(len(rows) - len(add), len(rows)))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main("--write" in sys.argv)
