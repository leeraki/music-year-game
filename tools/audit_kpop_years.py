"""K-POP 곡의 발표 연도를 위키백과와 대조한다.

연도는 이 게임의 정답이다. OST 는 작품 단위라 문서가 잘 잡히지만 곡은 그렇지
않다. 곡 문서가 없으면 검색이 가수 문서로 떨어지고, 거기서 연도를 뽑으면
가수의 생년이 나온다(전인권 → 1954). 그래서 문서 제목에 곡 이름이 들어간
것만 인정한다. 못 찾은 곡은 '확인불가' 로 남길 뿐 추측하지 않는다.

받아온 문서는 파일에 쌓는다. 중간에 막혀도 다시 받지 않는다.

사용법:
    python audit_kpop_years.py
"""
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
CACHE = os.path.join(HERE, ".wiki_song_cache.json")
UA = {"User-Agent": "music-year-game/1.0 (personal party game)"}
API = "https://ko.wikipedia.org/w/api.php?"

cache = json.load(open(CACHE, encoding="utf-8")) if os.path.exists(CACHE) else {}


def search(term):
    if term in cache:
        return cache[term]
    q = urllib.parse.urlencode({
        "action": "query", "generator": "search", "gsrsearch": term, "gsrlimit": 5,
        "prop": "extracts", "exintro": 1, "explaintext": 1, "format": "json",
    })
    for attempt in range(5):
        try:
            d = json.load(urllib.request.urlopen(
                urllib.request.Request(API + q, headers=UA), timeout=30))
            break
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 4:
                raise
            time.sleep(15 * (attempt + 1))
        except Exception:
            if attempt == 4:
                raise
            time.sleep(5)
    out = [{"title": p.get("title"), "extract": p.get("extract") or ""}
           for p in d.get("query", {}).get("pages", {}).values()]
    cache[term] = out
    json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    time.sleep(2)
    return out


def norm(s):
    return re.sub(r"[^0-9a-z가-힣]", "", (s or "").lower())


def year_of(text):
    """발매를 말하는 문장에서 연도를 뽑는다."""
    for sent in re.split(r"(?<=다\.)\s*|(?<=\.)\s+", text):
        if re.search(r"(발매|발표|공개|출시|수록|싱글)", sent):
            m = re.search(r"(19|20)\d{2}(?=년)", sent)
            if m:
                return int(m.group(0))
    m = re.search(r"(19|20)\d{2}(?=년)", text)
    return int(m.group(0)) if m else None


def look_up(song):
    """이 곡을 다루는 문서에서 연도를 찾는다. 가수 문서는 인정하지 않는다."""
    title = song.get("title") or song.get("song")
    want = norm(title)
    if len(want) < 2:
        return None
    for term in ("{} {} 노래".format(song["artist"], title),
                 "{} {}".format(song["artist"], title)):
        try:
            hits = search(term)
        except Exception:
            return None
        for h in hits:
            t = norm(h["title"])
            # 문서 제목이 곡 이름을 담고 있어야 그 곡 이야기다
            if want not in t:
                continue
            if norm(song["artist"]) == t:      # 가수 이름과 곡 이름이 같은 경우
                continue
            y = year_of(h["extract"])
            if y:
                return y, h["title"], h["extract"][:100].replace("\n", " ")
    return None


def main():
    songs = json.load(open(os.path.join(ROOT, "data", "kpop.json"), encoding="utf-8"))["songs"]
    ok, diff, miss = [], [], []
    for i, s in enumerate(songs, 1):
        r = look_up(s)
        if r is None:
            miss.append(s)
        elif r[0] == s["year"]:
            ok.append(s)
        else:
            diff.append((s, r))
        if i % 25 == 0:
            print("   {}/{}".format(i, len(songs)), flush=True)

    print("\n일치 {} · 불일치 {} · 확인불가 {}  (총 {}곡)\n".format(
        len(ok), len(diff), len(miss), len(songs)))
    print("■ 연도가 다름 — 확인 필요")
    for s, (y, t, ex) in sorted(diff, key=lambda x: x[0]["year"]):
        print("   {} → {}   {} — {}".format(s["year"], y, s["artist"], s["title"]))
        print("        [{}] {}".format(t, ex))
    print("\n■ 위키백과에 곡 문서가 없음 ({}곡) — 음반 연도로만 뒷받침됨".format(len(miss)))
    far = [s for s in miss if s.get("itunesYear") and abs(s["itunesYear"] - s["year"]) > 0]
    for s in sorted(far, key=lambda x: x["year"]):
        print("   {}  {} — {}   (음반 {})".format(s["year"], s["artist"], s["title"], s["itunesYear"]))
    json.dump({"diff": [[s["artist"], s["title"], s["year"], r[0]] for s, r in diff],
               "miss": [[s["artist"], s["title"], s["year"], s.get("itunesYear")] for s in miss]},
              open(os.path.join(HERE, ".kpop_year_audit.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
