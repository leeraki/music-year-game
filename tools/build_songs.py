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
import difflib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SEED_CSV = os.path.join(HERE, "seed_kpop.csv")
CACHE = os.path.join(HERE, ".itunes_cache.json")
OUT_JSON = os.path.join(ROOT, "data", "kpop.json")
REPORT = os.path.join(HERE, "review_report.txt")

SEARCH_URL = "https://itunes.apple.com/search"
DEFAULT_DELAY = 5.0      # 분당 12회. 3.2초 간격으로도 403 을 맞아서 더 낮췄다.
MAX_RETRY = 8
PROBE_INTERVAL = 300     # 차단 상태 재확인 간격(초). 자주 찔러도 더 빨리 풀리지는 않았다.
MAX_BLOCK_WAIT = 21600   # 차단 해제를 기다리는 최대 시간(초, 6시간)

# 편집/베스트 앨범은 원곡 발매일을 덮어써 연도를 오염시키므로 매칭 점수를 깎는다
# 'original' 은 뺐다. '김완선 - The Original' 처럼 원곡을 모아 재발매한 음반이라
# 감점하면 오히려 2023년 재녹음판이 이겨 버린다.
COMPILATION_HINTS = [
    "best", "greatest", "collection", "golden", "hits",
    "anthology", "remaster", "리마스터", "베스트", "골든", "모음", "전집",
]

# 라이브·리믹스·재녹음은 사람들이 아는 원곡과 음원이 달라 게임에 쓸 수 없다.
# 실제로 '조용필 창밖의 여자'가 2009년 라이브로, '김완선 오늘밤'이 2025년 리믹스로
# 잡힌 적이 있어 강하게 배제한다.
# 'mr'(반주) 은 'Mr. Chu' 같은 제목에 걸려 빼고, instrumental/반주 로 대신 잡는다.
VARIANT_HINTS = [
    "live", "remix", "acoustic", "inst", "instrumental", "karaoke",
    "cover", "rearrange", "reissue", "ver.", "version", "edit", "on stage",
    "라이브", "리믹스", "어쿠스틱", "재녹음", "커버", "반주", "mixed", "concert"]

# 표기가 갈리는 가수를 이어 주는 대조표. 여기 걸리면 가수가 일치하는 것으로 본다.
ARTIST_ALIASES = {
    "젝스키스": ["sechskies", "sechs kies"],
    "지오디": ["god"], "god": ["지오디"],
    "동방신기": ["tvxq", "tohoshinki"],
    "소녀시대": ["girls generation", "girls' generation", "snsd"],
    "빅뱅": ["bigbang", "big bang"], "방탄소년단": ["bts"],
    "블랙핑크": ["blackpink"], "아이유": ["iu"], "원더걸스": ["wonder girls"],
    "슈퍼주니어": ["super junior"], "브라운아이즈": ["brown eyes"],
    "서태지와 아이들": ["seotaiji and boys", "seo taiji and boys", "서태지"],
    "무한궤도": ["신해철"], "에스파": ["aespa"], "아이브": ["ive"],
    "뉴진스": ["newjeans"], "르세라핌": ["le sserafim"], "트와이스": ["twice"],
    "엑소": ["exo"], "레드벨벳": ["red velvet"], "여자친구": ["gfriend"],
    "에이핑크": ["apink"], "씨스타": ["sistar"], "인피니트": ["infinite"],
    "비스트": ["beast"], "티아라": ["t-ara", "tara"], "카라": ["kara"],
    "미쓰에이": ["miss a"], "악동뮤지션": ["akmu", "악뮤"], "악뮤": ["akmu", "악동뮤지션"],
    "우즈": ["woodz"], "제니": ["jennie"], "텐": ["ten"], "화사": ["hwasa"],
    "에이티즈": ["ateez"], "데이식스": ["day6"], "트레저": ["treasure"],
    "키스오브라이프": ["kiss of life"], "엔하이픈": ["enhypen"],
    "아이오아이": ["ioi", "i.o.i"], "싸이": ["psy"], "보아": ["boa"],
    "비": ["rain"], "세븐": ["se7en"], "휘성": ["wheesung"],
    "에픽하이": ["epik high"], "드렁큰타이거": ["drunken tiger"],
    "클론": ["clon"], "룰라": ["roo'ra", "roora"], "핑클": ["fin.k.l", "finkl"],
    "코요태": ["koyote"], "터보": ["turbo"], "투투": ["two two"],
    "베이비복스": ["baby vox"], "신화": ["shinhwa"], "씨야": ["seeya"],
    "다비치": ["davichi"], "브라운아이드걸스": ["brown eyed girls"],
    "씨엔블루": ["cnblue"], "샤이니": ["shinee"], "아이콘": ["ikon"],
    "워너원": ["wanna one"], "아이즈원": ["iz*one", "izone"], "지코": ["zico"],
    "폴킴": ["paul kim"], "자이언티": ["zion.t"], "볼빨간사춘기": ["bol4"],
    "태양": ["taeyang"], "들국화": ["deulgukhwa"], "015b": ["공일오비"],
    "공일오비": ["015b"], "양파": ["yangpa"], "엔믹스": ["nmixx"],
    "베이비몬스터": ["babymonster"], "아이들": ["(g)i-dle", "gidle", "여자아이들"],
    "헌트릭스": ["huntrix", "huntr/x"], "h.o.t.": ["hot"], "s.e.s.": ["ses"],
    "이상은": ["lee tzsche", "lee sang eun"], "아일릿": ["illit"], "투어스": ["tws"],
    "피프티피프티": ["fifty fifty"], "오마이걸": ["oh my girl"],
    "브레이브걸스": ["brave girls"], "모모랜드": ["momoland"],
    "크레용팝": ["crayon pop"], "버스커버스커": ["busker busker"],
    "잔나비": ["jannabi"], "유승준": ["steve yoo"], "전인권": ["jeon in kwon"],
    "sg워너비": ["sg wannabe"], "ft아일랜드": ["ftisland", "ft island", "f.t. island"],
    "소유 정기고": ["soyou", "junggigo", "소유", "정기고"],
    "산울림": ["sanulrim", "sanullim"], "김수철": ["kim soo chul"],
    "윤상": ["yoon sang"], "이승기": ["lee seung gi"], "양수경": ["yang su kyung"],
    "핑클": ["fin.k.l", "finkl", "fin k l"], "015b": ["공일오비", "015b"],
    "다비치": ["davichi"], "2pm": ["투피엠"], "비스트": ["beast", "b2st"],
    "씨엔블루": ["cnblue"], "브라운아이드걸스": ["brown eyed girls"],
    "조성모": ["jo sung mo"], "서태지와 아이들": ["seotaiji and boys", "seo taiji and boys", "서태지"],
    "kiiikiii": ["키키"], "cortis": ["코르티스"], "rescene": ["리센느"],
    "hearts2hearts": ["하츠투하츠"], "nmixx": ["엔믹스"], "qwer": ["큐더블유이알"],
    "악동뮤지션": ["akmu", "악뮤"], "아이오아이": ["ioi", "i.o.i", "아이오아이"],
    "엑소": ["exo"], "엔하이픈": ["enhypen"],
}


def norm(s):
    """
    비교용 정규화: 소문자 + 괄호/특수문자 제거.

    악센트를 그냥 지우면 'Céline' 이 'cline' 이 되어 'Celine' 과 어긋난다.
    분해 정규화로 악센트만 떼어내 기본 글자를 살린다.
    """
    # NFD 는 한글 음절도 자모로 쪼갠다('백' → ᄇ ᅢ ᆨ). 그대로 두면 아래 [가-힣]
    # 필터가 자모를 전부 걸러 한글이 통째로 사라진다. 그래서 NFC 로 다시 합친다.
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = unicodedata.normalize("NFC", s)
    s = re.sub(r"\([^)]*\)", "", s)
    s = re.sub(r"\[[^\]]*\]", "", s)
    # 히라가나·가타카나·한자도 남긴다. 일본 애니 OST 는 원제가 일본어라
    # 이 범위를 빼면 제목이 통째로 사라져 비교가 불가능해진다.
    s = re.sub(r"[^0-9a-z가-힣ぁ-ゖァ-ヺ一-龯]", "", s)
    return s


def similarity(a, b):
    """
    글자 '집합' 만 비교하면 짧은 영문 제목에서 엉뚱하게 높은 점수가 나온다.
    'Mr. Chu' 와 'Remember' 가 공통 글자 m, r 때문에 0.40 을 받아 통과한 적이 있다.
    순서까지 보는 SequenceMatcher 로 비교한다.
    """
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # 부제만 붙은 경우('Gee' vs 'Gee (Remix)')를 살리되, 너무 짧은 조각에는 주지 않는다
    if (a in b or b in a) and min(len(a), len(b)) >= 3:
        return 0.85
    return difflib.SequenceMatcher(None, a, b).ratio()


def artist_ok(seed_artist, candidate_artist):
    """가수가 같다고 볼 수 있는가. 표기 차이는 대조표로 흡수한다."""
    a, b = norm(seed_artist), norm(candidate_artist)
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    for alias in ARTIST_ALIASES.get(seed_artist.strip().lower(), []):
        c = norm(alias)
        if c and (c == b or c in b or b in c):
            return True
    return False


_VARIANT_RE = re.compile(
    r"(?<![a-z])(" + "|".join(
        re.escape(h) for h in VARIANT_HINTS if h.isascii()
    ) + r")(?![a-z])",
    re.IGNORECASE,
)
# 한글도 앞뒤가 한글이면 단어의 일부다. '버스커버스커' 안의 '커버'가 그런 경우다.
_VARIANT_KO_RE = re.compile(
    r"(?<![가-힣])(" + "|".join(
        re.escape(h) for h in VARIANT_HINTS if not h.isascii()
    ) + r")(?![가-힣])"
)


_LANG_VER_RE = re.compile(r"(korean|japanese|chinese|english|mandarin)\s*(ver\.|version)", re.I)


def is_variant(cand):
    """
    라이브·리믹스·재녹음 등 원곡과 음원이 다른 버전인가.

    단순 부분문자열로 보면 빅뱅 앨범 'Alive' 가 'live' 를, '버스커버스커' 가 '커버' 를
    품어 전부 라이브로 오판된다. 그래서 앞뒤 글자를 함께 본다.
    """
    blob = f"{cand.get('trackName', '')} {cand.get('collectionName', '')}"
    # 'Korean Version' 은 언어판 표기다. 한국 가수에게는 오히려 그쪽이 원반이라
    # 변형으로 보고 감점하면 정작 원곡을 밀어낸다.
    blob = _LANG_VER_RE.sub(" ", blob)
    return bool(_VARIANT_RE.search(blob) or _VARIANT_KO_RE.search(blob))


def title_similarity(track_name, title, alt=None):
    """
    한글 제목과 영문 제목은 글자가 하나도 겹치지 않아 유사도가 0 이 된다.
    (예: '위아래' vs 'Up & Down') 그래서 시드에 대체 표기를 적어 함께 비교한다.
    """
    best = similarity(track_name, title)
    if alt:
        best = max(best, similarity(track_name, alt))
    return best


def score_candidate(cand, artist, title, seed_year=None, alt=None):
    if not cand.get("previewUrl"):
        return -99.0

    # 가수가 다르면 제목이 똑같아도 다른 곡이다.
    # '젝스키스 폼생폼사'가 'UNEDUCATED KID 폼생폼사'로 잡힌 사고의 원인이 여기였다.
    if not artist_ok(artist, cand.get("artistName", "")):
        return -50.0

    t = title_similarity(cand.get("trackName", ""), title, alt)

    # 제목이 전혀 안 맞으면 같은 가수의 다른 곡이다. 연도만 맞아서 통과하면 안 된다.
    # 'EXID 위아래'가 같은 해에 나온 'Ah Yeah'로 잡힌 사고의 원인이 여기였다.
    if t < 0.34:
        return -30.0

    s = t * 3.0
    # 제목이 정확히 같으면 확실한 신호다. 이 가산이 없으면 연도 가산점(+2.0)이
    # 제목 차이를 눌러, DJ DOC 「겨울 이야기」자리에 같은 해에 나온 「여름 이야기」가
    # 들어가는 일이 생긴다.
    if t >= 1.0:
        s += 2.5

    album = (cand.get("collectionName") or "").lower()
    if any(h in album for h in COMPILATION_HINTS):
        s -= 1.2
    if is_variant(cand):
        s -= 3.0

    # 원반에 가까울수록 좋다. 발매 당시 음원이라야 사람들이 아는 그 소리가 난다.
    if seed_year:
        try:
            gap = abs(int(cand["releaseDate"][:4]) - seed_year)
            s += 2.0 if gap == 0 else 1.4 if gap <= 1 else 0.6 if gap <= 3 else -min(gap * 0.12, 2.5)
        except (KeyError, ValueError, TypeError):
            pass
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


def build(limit=None, delay=DEFAULT_DELAY, cache_only=False):
    with open(SEED_CSV, encoding="utf-8") as f:
        seeds = list(csv.DictReader(f))
    if limit:
        seeds = seeds[:limit]

    cache = load_cache()
    songs, problems = [], []
    fetched = 0
    skipped_uncached = 0
    # 서로 다른 시드가 같은 트랙에 매칭되면 한 판에 같은 곡이 두 번 나온다.
    # 실제로 검색어를 잘못 지정해 겪은 적이 있어 수집 단계에서 막는다.
    claimed = {}

    # audit_songs.py 가 오매칭으로 지목한 트랙은 다시 뽑지 않는다
    blocked = set()
    blocked_path = os.path.join(HERE, "blocked_tracks.json")
    if os.path.exists(blocked_path):
        try:
            blocked = set(json.load(open(blocked_path, encoding="utf-8")))
            print(f"  (오매칭 트랙 {len(blocked)}개 제외)")
        except Exception:
            pass

    for i, row in enumerate(seeds, 1):
        year = int(row["year"])
        artist = row["artist"].strip()
        title = row["title"].strip()
        alt = (row.get("alt") or "").strip() or None
        term = (row.get("search") or "").strip() or f"{artist} {title}"

        if term in cache:
            results = cache[term]
            tag = "캐시"
        elif cache_only:
            # 캐시에 없는 곡은 건너뛴다. 차단 중에도 받아둔 만큼은 덱에 반영하기 위한 경로다.
            skipped_uncached += 1
            continue
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

        # 이미 다른 곡이 가져간 트랙과, 감사에서 오매칭으로 걸러낸 트랙은 후보에서 뺀다
        ranked = sorted(usable, key=lambda c: score_candidate(c, artist, title, year, alt), reverse=True)
        best = next(
            (c for c in ranked
             if c["trackId"] not in claimed
             and c["trackId"] not in blocked
             and score_candidate(c, artist, title, year, alt) > 0),
            None,
        )
        if best is None:
            top = ranked[0] if ranked else None
            why = "가수가 일치하는 후보가 없습니다" if top and not artist_ok(artist, top.get("artistName", "")) \
                  else "쓸 만한 후보가 없습니다"
            problems.append(
                f"[매칭실패] {year} {artist} - {title}\n"
                f"           최상위 후보: {top.get('artistName') if top else '없음'} - "
                f"{top.get('trackName') if top else '없음'}\n"
                f"           사유: {why}"
            )
            print(f"  {i:3d}/{len(seeds)} [MISS] {artist} - {title}")
            continue
        claimed[best["trackId"]] = f"{artist} - {title}"

        conf = score_candidate(best, artist, title, year, alt)
        itunes_year = int(best["releaseDate"][:4])

        songs.append({
            "id": f"s{best['trackId']}",
            "year": year,                   # 큐레이션 확정 연도 (게임 정답)
            "title": title,                 # 화면 표기는 큐레이션 표기를 따른다
            "alt": alt,   # Spotify 가 쓰는 다른 표기(영어 제목 등). 검색·대조에 쓴다.
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
        if abs(itunes_year - year) > 3:
            flags.append(f"연도차 iTunes {itunes_year} vs 시드 {year}")
        if is_variant(best):
            flags.append("라이브/리믹스 의심 — 원곡 음원이 아닐 수 있음")
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
    print(f"수집 성공 : {len(songs)} / {len(seeds)} 곡  (신규 요청 {fetched}건"
          + (f", 캐시없어 건너뜀 {skipped_uncached}곡" if skipped_uncached else "") + ")")
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
    p.add_argument("--cache-only", action="store_true",
                   help="네트워크 요청 없이 캐시에 있는 곡만으로 songs.json 을 만든다")
    args = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    build(args.limit, args.delay, args.cache_only)
