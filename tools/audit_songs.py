"""
data/songs.json 에 잘못 매칭된 곡이 있는지 점검한다.

'폼생폼사' 처럼 제목만 같고 가수가 전혀 다른 곡이 섞여 들어간 사고가 있었다.
네트워크를 쓰지 않고 저장된 필드만 비교하므로 iTunes 차단 중에도 돌릴 수 있다.

사용법:
    python audit_songs.py            # 의심 항목 출력
    python audit_songs.py --strict   # 경미한 차이까지 전부 출력
"""

import argparse
import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
SONGS = os.path.join(os.path.dirname(HERE), "data", "songs.json")

# 같은 가수를 다르게 표기하는 경우가 많아 대조표를 둔다
ALIASES = {
    "젝스키스": ["sechskies", "sechs kies"],
    "지오디": ["god"],
    "god": ["지오디"],
    "동방신기": ["tvxq", "tohoshinki"],
    "소녀시대": ["girls generation", "girls' generation", "snsd"],
    "빅뱅": ["bigbang", "big bang"],
    "방탄소년단": ["bts"],
    "블랙핑크": ["blackpink"],
    "아이유": ["iu"],
    "원더걸스": ["wonder girls"],
    "슈퍼주니어": ["super junior"],
    "브라운아이즈": ["brown eyes"],
    "서태지와 아이들": ["seotaiji and boys", "seo taiji and boys", "서태지"],
    "무한궤도": ["신해철"],
    "에스파": ["aespa"],
    "아이브": ["ive"],
    "뉴진스": ["newjeans"],
    "르세라핌": ["le sserafim"],
    "트와이스": ["twice"],
    "엑소": ["exo"],
    "레드벨벳": ["red velvet"],
    "여자친구": ["gfriend"],
    "에이핑크": ["apink"],
    "씨스타": ["sistar"],
    "인피니트": ["infinite"],
    "비스트": ["beast"],
    "티아라": ["t-ara", "tara"],
    "카라": ["kara"],
    "미쓰에이": ["miss a"],
    "악동뮤지션": ["akmu", "악뮤"],
    "악뮤": ["akmu", "악동뮤지션"],
    "잔나비": ["jannabi"],
    "우즈": ["woodz"],
    "제니": ["jennie"],
    "텐": ["ten"],
    "화사": ["hwasa"],
    "에이티즈": ["ateez"],
    "데이식스": ["day6"],
    "트레저": ["treasure"],
    "키스오브라이프": ["kiss of life"],
    "엔하이픈": ["enhypen"],
    "아이오아이": ["ioi", "i.o.i"],
    "싸이": ["psy"],
    "이효리": ["lee hyori"],
    "보아": ["boa"],
    "세븐": ["se7en"],
    "비": ["rain"],
    "휘성": ["wheesung"],
    "에픽하이": ["epik high"],
    "드렁큰타이거": ["drunken tiger"],
    "클론": ["clon", "koolon"],
    "룰라": ["roo'ra", "roora"],
    "핑클": ["fin.k.l", "finkl"],
    "코요태": ["koyote"],
    "터보": ["turbo"],
    "노이즈": ["noise"],
    "투투": ["two two"],
    "베이비복스": ["baby vox"],
    "이정현": ["lee jung hyun"],
    "왁스": ["wax"],
    "신화": ["shinhwa"],
    "김종국": ["kim jong kook"],
    "씨야": ["seeya"],
    "이승기": ["lee seung gi"],
    "다비치": ["davichi"],
    "브라운아이드걸스": ["brown eyed girls"],
    "씨엔블루": ["cnblue"],
    "샤이니": ["shinee"],
    "아이콘": ["ikon"],
    "워너원": ["wanna one"],
    "아이즈원": ["iz*one", "izone"],
    "지코": ["zico"],
    "폴킴": ["paul kim"],
    "자이언티": ["zion.t", "ziont"],
    "볼빨간사춘기": ["bol4", "botopass"],
    "태양": ["taeyang"],
    "윤미래": ["yoon mirae", "t"],
    "들국화": ["deulgukhwa"],
    "산울림": ["sanullim"],
    "동물원": ["dongmulwon"],
    "푸른하늘": ["blue sky"],
    "유재하": ["yoo jae ha"],
    "이문세": ["lee moon sae"],
    "조용필": ["cho yong pil", "jo yong pil"],
    "이선희": ["lee sun hee"],
    "김건모": ["kim gun mo"],
    "신승훈": ["shin seung hun"],
    "이승철": ["lee seung chul"],
    "변진섭": ["byun jin sub"],
    "김완선": ["kim wan sun"],
    "소방차": ["sobangcha"],
    "주현미": ["joo hyun mi"],
    "나미": ["nami"],
    "이상은": ["lee tzsche", "lee sang eun"],
    "강수지": ["kang susie"],
    "김현식": ["kim hyun sik"],
    "윤상": ["yoon sang"],
    "015b": ["공일오비"],
    "공일오비": ["015b"],
    "정수라": ["jung soo ra"],
    "김수철": ["kim soo chul"],
    "이용": ["lee yong"],
    "양파": ["yangpa"],
    "조성모": ["jo sung mo"],
    "김현정": ["kim hyun jung"],
    "쿨": ["cool"],
    "성시경": ["sung si kyung"],
    "이수영": ["lee soo young"],
    "sg워너비": ["sg wannabe"],
    "mc몽": ["mc mong"],
    "버즈": ["buzz"],
    "아이비": ["ivy"],
    "ft아일랜드": ["ft island", "f.t. island"],
    "2ne1": ["투애니원"],
    "2pm": ["투피엠"],
    "exid": ["이엑스아이디"],
    "유승준": ["steve yoo"],
    "전인권": ["jeon in kwon"],
    "양수경": ["yang su kyung"],
    "크레용팝": ["crayon pop"],
    "버스커버스커": ["busker busker"],
    "모모랜드": ["momoland"],
    "itzy": ["있지"],
    "stayc": ["스테이씨"],
    "오마이걸": ["oh my girl"],
    "브레이브걸스": ["brave girls"],
    "피프티피프티": ["fifty fifty"],
    "아일릿": ["illit"],
    "투어스": ["tws"],
    "엔믹스": ["nmixx"],
    "nmixx": ["엔믹스"],
    "베이비몬스터": ["babymonster"],
    "아이들": ["(g)i-dle", "gidle", "여자아이들"],
    "헌트릭스": ["huntrix", "huntr/x"],
    "qwer": ["큐더블유이알"],
    "h.o.t.": ["hot", "에이치오티"],
    "s.e.s.": ["ses"],
    "dj doc": ["디제이디오씨"],
    "cortis": ["코르티스"],
    "kiiikiii": ["키키"],
    "hearts2hearts": ["하츠투하츠"],
    "rescene": ["리센느"],
    "미스에이": ["miss a"],
    "소유 정기고": ["soyou", "junggigo"],
    "이승환": ["lee seung hwan"],
}


def norm(s):
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = re.sub(r"\([^)]*\)", "", s)
    s = re.sub(r"\[[^\]]*\]", "", s)
    s = re.sub(r"feat\.?.*$", "", s)
    return re.sub(r"[^0-9a-z가-힣]", "", s)


def artist_matches(seed, matched):
    a, b = norm(seed), norm(matched)
    if not a or not b:
        return 0.0
    if a == b or a in b or b in a:
        return 1.0
    for alias in ALIASES.get(seed.strip().lower(), []):
        c = norm(alias)
        if c and (c == b or c in b or b in c):
            return 1.0
    # 한글/영문이 섞여 글자 교집합이 의미 없을 때를 대비한 보조 지표
    common = len(set(a) & set(b))
    return common / max(len(set(a)), len(set(b)))


def load_alt_map():
    """시드에 적어 둔 iTunes 표기. 수집과 같은 기준으로 봐야 헛경고가 없다."""
    import csv
    path = os.path.join(HERE, "seed_songs.csv")
    if not os.path.exists(path):
        return {}
    out = {}
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r.get("alt"):
                out[(r["artist"].strip(), r["title"].strip())] = r["alt"].strip()
    return out


def main(strict=False):
    data = json.load(open(SONGS, encoding="utf-8"))
    songs = data["songs"]
    alt_map = load_alt_map()

    bad, warn, seen_track = [], [], {}

    for s in songs:
        seed_artist, matched_artist = s["artist"], s.get("itunesArtist", "")
        seed_title, matched_title = s["title"], s.get("itunesTitle", "")

        a_score = artist_matches(seed_artist, matched_artist)
        alt = alt_map.get((seed_artist.strip(), seed_title.strip()))
        def same(x, y):
            a, b = norm(x), norm(y)
            return bool(a) and bool(b) and (a == b or a in b or b in a)
        t_ok = same(seed_title, matched_title) or (alt and same(alt, matched_title))

        reasons = []
        if a_score < 0.34:
            reasons.append(f"가수 불일치 (기대 '{seed_artist}' / 실제 '{matched_artist}')")
        if not t_ok:
            reasons.append(f"제목 불일치 (기대 '{seed_title}' / 실제 '{matched_title}')")

        gap = abs(s.get("itunesYear", s["year"]) - s["year"])
        if gap > 3:
            reasons.append(f"연도 {gap}년 차 (시드 {s['year']} / iTunes {s.get('itunesYear')})")

        tid = s.get("itunesTrackId")
        if tid in seen_track:
            reasons.append(f"트랙 중복 ({seen_track[tid]} 과 같은 트랙)")
        seen_track[tid] = f"{seed_artist} - {seed_title}"

        if reasons:
            entry = (s, reasons)
            (bad if any("불일치" in r or "중복" in r for r in reasons) else warn).append(entry)
        elif strict and gap > 1:
            warn.append((s, [f"연도 {gap}년 차"]))

    def dump(title, items):
        if not items:
            return
        print(f"\n{'=' * 68}\n{title} — {len(items)}건\n{'=' * 68}")
        for s, reasons in items:
            print(f"\n  {s['year']}  {s['artist']} - {s['title']}")
            print(f"     매칭: {s.get('itunesArtist')} - {s.get('itunesTitle')}")
            print(f"     앨범: {s.get('album')} ({s.get('itunesYear')})")
            for r in reasons:
                print(f"     ! {r}")

    dump("교체 필요 (다른 곡일 가능성 높음)", bad)
    dump("확인 권장", warn)

    print(f"\n{'=' * 68}")
    print(f"전체 {len(songs)}곡 / 교체 필요 {len(bad)}곡 / 확인 권장 {len(warn)}곡 / "
          f"정상 {len(songs) - len(bad) - len(warn)}곡")

    # 재수집 때 제외할 트랙을 남긴다.
    # '가수가 다른 경우'만 담는다. 제목 표기 차이(스피드/speed, 캔디/Candy)까지 담았더니
    # 정작 맞는 트랙이 차단되어 매칭이 통째로 실패한 적이 있다.
    wrong_artist = [s for s, reasons in bad if any("가수 불일치" in r for r in reasons)]
    block = os.path.join(HERE, "blocked_tracks.json")
    if wrong_artist:
        prev = json.load(open(block, encoding="utf-8")) if os.path.exists(block) else []
        ids = sorted({s["itunesTrackId"] for s in wrong_artist} | set(prev))
        json.dump(ids, open(block, "w", encoding="utf-8"))
        print(f"가수가 다른 트랙 {len(ids)}개를 tools/blocked_tracks.json 에 기록했습니다.")
    title_only = len(bad) - len(wrong_artist)
    if title_only:
        print(f"제목 표기만 다른 {title_only}곡은 차단하지 않았습니다 — "
              f"seed_songs.csv 의 alt 열에 iTunes 표기를 적어 주세요.")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--strict", action="store_true")
    args = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    main(args.strict)
