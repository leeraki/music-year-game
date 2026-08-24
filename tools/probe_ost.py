"""
OST 모드가 실현 가능한지 확인한다.

확인할 것:
  1) 한국 드라마 / 한국 영화 / 외국 영화 OST 가 iTunes 에 미리듣기와 함께 있는가
  2) 200곡 규모의 풀이 나올 만한가

iTunes 요청 제한이 빡빡해서 결과를 캐시에 남긴다(수집 스크립트와 같은 캐시를 쓴다).
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".itunes_cache.json")
DELAY = 5.0

# (분류, 작품, 작품연도, 곡, 가수)
SAMPLES = [
    # ---- 한국 드라마 ----
    ("드라마", "겨울연가", 2002, "처음부터 지금까지", "류"),
    ("드라마", "미안하다 사랑한다", 2004, "눈의 꽃", "박효신"),
    ("드라마", "내 이름은 김삼순", 2005, "She Is", "클래지콰이"),
    ("드라마", "궁", 2006, "Perhaps Love", "하울 제이"),
    ("드라마", "꽃보다 남자", 2009, "Paradise", "티맥스"),
    ("드라마", "시크릿 가든", 2010, "그 여자", "백지영"),
    ("드라마", "별에서 온 그대", 2013, "My Destiny", "린"),
    ("드라마", "태양의 후예", 2016, "Always", "윤미래"),
    ("드라마", "도깨비", 2016, "첫눈처럼 너에게 가겠다", "에일리"),
    ("드라마", "호텔 델루나", 2019, "그대라는 시", "태연"),
    ("드라마", "사랑의 불시착", 2019, "다시 난, 여기", "백예린"),
    ("드라마", "이태원 클라쓰", 2020, "시작", "가호"),
    ("드라마", "응답하라 1988", 2015, "청춘", "김필"),
    ("드라마", "눈물의 여왕", 2024, "우리의 이야기", "허각"),
    ("드라마", "선재 업고 튀어", 2024, "소나기", "이클립스"),

    # ---- 한국 영화 ----
    ("영화", "엽기적인 그녀", 2001, "I Believe", "신승훈"),
    ("영화", "클래식", 2003, "너에게 난 나에게 넌", "자전거 탄 풍경"),
    ("영화", "미녀는 괴로워", 2006, "마리아", "김아중"),
    ("영화", "건축학개론", 2012, "기억의 습작", "전람회"),
    ("영화", "써니", 2011, "Sunny", "보니엠"),
    ("영화", "왕의 남자", 2005, "인연", "이선희"),
    ("영화", "국화꽃 향기", 2003, "국화꽃 향기", "성시경"),

    # ---- 외국 영화 ----
    ("외화", "타이타닉", 1997, "My Heart Will Go On", "Celine Dion"),
    ("외화", "보디가드", 1992, "I Will Always Love You", "Whitney Houston"),
    ("외화", "겨울왕국", 2013, "Let It Go", "Idina Menzel"),
    ("외화", "라라랜드", 2016, "City of Stars", "Ryan Gosling"),
    ("외화", "위대한 쇼맨", 2017, "This Is Me", "Keala Settle"),
    ("외화", "알라딘", 2019, "A Whole New World", "Mena Massoud"),
    ("외화", "탑건", 1986, "Take My Breath Away", "Berlin"),
    ("외화", "사랑과 영혼", 1990, "Unchained Melody", "The Righteous Brothers"),
    ("외화", "노팅힐", 1999, "She", "Elvis Costello"),
    ("외화", "시네마 천국", 1988, "Love Theme", "Ennio Morricone"),
    ("외화", "인터스텔라", 2014, "Cornfield Chase", "Hans Zimmer"),
    ("외화", "미션 임파서블", 1996, "Mission Impossible Theme", "Adam Clayton"),
    ("외화", "글래디에이터", 2000, "Now We Are Free", "Lisa Gerrard"),
    ("외화", "물랑루즈", 2001, "Come What May", "Ewan McGregor"),
    ("외화", "슬럼독 밀리어네어", 2008, "Jai Ho", "A.R. Rahman"),
    ("외화", "겨울왕국 2", 2019, "Into the Unknown", "Idina Menzel"),
    ("외화", "레미제라블", 2012, "I Dreamed a Dream", "Anne Hathaway"),
    ("외화", "보헤미안 랩소디", 2018, "Bohemian Rhapsody", "Queen"),
]


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
        headers={"User-Agent": "Mozilla/5.0 (music-game-ost-probe)"},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                res = json.loads(r.read().decode("utf-8")).get("results", [])
            cache[term] = res
            time.sleep(DELAY)
            return res, False
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                print(f"      제한({e.code}) — 90초 대기", flush=True)
                time.sleep(90)
                continue
            raise
    return [], False


def main():
    cache = load_cache()
    stats = {}
    hits = []

    for i, (kind, work, year, song, artist) in enumerate(SAMPLES, 1):
        term = f"{artist} {song}"
        try:
            res, cached = search(term, cache)
        except Exception as e:
            print(f"  {i:2d}. [ERR ] {work} - {song}: {e}")
            continue

        usable = [r for r in res if r.get("previewUrl")]
        # OST 여부 판단에 도움이 되도록 앨범명에 작품명이 들어있는지도 본다
        ost_ish = [r for r in usable
                   if "ost" in (r.get("collectionName") or "").lower()
                   or work.replace(" ", "") in (r.get("collectionName") or "").replace(" ", "")]

        stats.setdefault(kind, {"ok": 0, "no": 0})
        if usable:
            stats[kind]["ok"] += 1
            best = (ost_ish or usable)[0]
            hits.append((kind, work, year, song, best))
            tag = "OST앨범" if ost_ish else "일반"
            print(f"  {i:2d}. [OK  ] {kind} {work}({year}) — {best['artistName'][:16]} / "
                  f"{best['trackName'][:26]} [{tag}] {'(캐시)' if cached else ''}")
        else:
            stats[kind]["no"] += 1
            print(f"  {i:2d}. [없음] {kind} {work}({year}) — {artist} / {song}")

    json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)

    print("\n" + "=" * 62)
    total_ok = sum(v["ok"] for v in stats.values())
    for kind, v in stats.items():
        rate = v["ok"] / (v["ok"] + v["no"]) * 100
        print(f"  {kind:4} : {v['ok']:2d}/{v['ok']+v['no']:2d} 확보  ({rate:.0f}%)")
    print(f"  전체 : {total_ok}/{len(SAMPLES)} ({total_ok/len(SAMPLES)*100:.0f}%)")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
