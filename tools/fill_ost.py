"""
곡이 비어 있는 OST 항목을 캐시된 검색 결과로 자동으로 채운다.

discover_ost.py 가 후보를 보여주는 도구라면, 이쪽은 그 후보 중에서 규칙에 맞는 것을
골라 seed_ost.csv 에 써 넣는다. 90개를 손으로 옮겨 적으면 오타가 나기 쉬워서 만들었다.

고르는 기준:
  1. 앨범명에 작품 이름이나 OST/Soundtrack 이 들어갈 것 — 그 작품의 음원이라는 근거
  2. 반주·스코어 조각·피아노 커버는 제외 — 게임에서 알아들을 수 없다
  3. 남으면 수록곡이 많은 앨범(정규 OST 음반)의 것을 우선

사용법:
    python fill_ost.py            # 채운 뒤 결과 요약
    python fill_ost.py --dry      # 무엇이 채워질지 보기만 한다
"""

import argparse
import csv
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(HERE, "seed_ost.csv")
CACHE = os.path.join(HERE, ".itunes_cache.json")

# 게임에 쓸 수 없는 트랙 (가사가 없거나 원곡이 아님)
SKIP_TRACK = [
    "inst", "instrumental", "반주", "narration", "나레이션", "피아노", "piano",
    "score", "interlude", "theme song ver", "guitar", "orgel", "오르골", "cover",
]

# 노래가 아니라 배경음악(스코어)일 가능성이 큰 신호.
# 듣고 맞히는 게임이라 가사 있는 보컬곡이라야 한다.
SCORE_TITLE = re.compile(
    r"(main\s*theme|title\s*theme|opening|ending|prologue|epilogue|suite|"
    r"오프닝|엔딩|서곡|메인\s*테마|타이틀\s*테마|연주곡)", re.I)

# 드라마 음악감독·작곡가. 이들 이름으로 올라온 트랙은 스코어인 경우가 많다.
# 다만 가수를 feat. 로 세운 보컬곡도 있어 배제가 아니라 후순위로만 둔다.
COMPOSERS = {
    "남혜승", "개미", "박성일", "김준석", "이필호", "방준석", "조영욱", "달파란",
    "이재진", "정세린", "황상준", "신인수", "전창엽", "김현준", "이동준", "김해원",
    "이지수", "최인희", "정재일", "김태성", "홍동표", "이병우", "장영규", "노형우",
    "전세진", "김지수",
}


def score_like(cand):
    """배경음악으로 보이는가."""
    t = cand.get("trackName") or ""
    a = cand.get("artistName") or ""
    if SCORE_TITLE.search(t):
        return True
    # 작곡가 이름만 단독으로 올라온 트랙 (feat. 로 가수가 붙으면 보컬곡으로 본다)
    return any(c in a for c in COMPOSERS) and "feat" not in (t + a).lower()
# 작품과 무관한 편집/커버 음반
# '벨' 처럼 짧은 조각으로 거르면 '레드벨벳'까지 걸린다. 실제로 겪어서 표기를 늘렸다.
SKIP_ALBUM = ["ost 피아노", "드라마 ost 피아노", "노래방", "karaoke", "가요반주",
              "벨소리", "화음벨", "ringtone", "메들리", "medley", "오르골"]


def norm(s):
    return re.sub(r"[^0-9a-z가-힣]", "", (s or "").lower())


def pick(work, results):
    """작품 OST 앨범에 속한 트랙 중 가장 그럴듯한 것을 고른다."""
    w = norm(work)
    out = []
    for c in results:
        if not c.get("previewUrl"):
            continue
        track = (c.get("trackName") or "").lower()
        album = (c.get("collectionName") or "")
        al = album.lower()
        if any(s in track for s in SKIP_TRACK):
            continue
        if any(s in al for s in SKIP_ALBUM):
            continue
        # 그 작품의 음원이라는 근거가 반드시 있어야 한다.
        # 'OST 가 붙은 앨범이면 통과'로 뒀더니 다른 작품의 사운드트랙이 대거 섞였다
        # (「질투」에 슬기로운 의사생활 OST, 「사도」에 The Shape of Water OST).
        if not (w and (w in norm(album) or w in norm(c.get("trackName")))):
            continue
        # 보컬곡을 앞에 세운다. 스코어밖에 없으면 그때 쓴다.
        out.append((1 if score_like(c) else 0, -(c.get("trackCount") or 0), c))
    if not out:
        return None
    out.sort(key=lambda t: (t[0], t[1]))
    return out[0][2]


FIELDS = ["year", "type", "work", "characters", "actors",
          "song", "artist", "search", "alt", "verified"]


def write_seed(rows):
    """
    임시 파일에 다 쓰고 나서 원본과 바꾼다.

    바로 "w" 로 열면 그 순간 파일이 비워진다. 실제로 열 이름이 안 맞아 쓰기 도중
    예외가 났을 때 시드 207개가 통째로 날아갔다(git 에서 복구).
    """
    d = os.path.dirname(SEED)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".csv")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow({k: r.get(k, "") for k in FIELDS})
        os.replace(tmp, SEED)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def main(dry=False):
    cache = json.load(open(CACHE, encoding="utf-8")) if os.path.exists(CACHE) else {}
    rows = list(csv.DictReader(open(SEED, encoding="utf-8")))

    filled, failed = [], []
    for r in rows:
        if r["song"].strip() and r["artist"].strip():
            continue
        work = r["work"].strip()
        term = (r.get("search") or "").strip() or f"{work} OST"
        best = pick(work, cache.get(term) or [])
        if not best:
            failed.append(f"{r['year']} {work}")
            continue
        r["song"] = best["trackName"]
        r["artist"] = best["artistName"]
        r["search"] = term
        filled.append(f"{r['year']} {work:<22} → {best['artistName']} / {best['trackName']}")

    if not dry:
        write_seed(rows)

    for line in filled:
        print("  " + line)
    print(f"\n채움 {len(filled)}개 / 후보 없음 {len(failed)}개" + (" (미리보기)" if dry else ""))
    if failed:
        print("  후보 없음: " + ", ".join(failed))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--dry", action="store_true")
    args = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    main(args.dry)
