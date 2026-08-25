"""작품의 첫 방영/개봉 연도를 한국어 위키백과와 대조한다.

연도는 이 게임의 정답이다. 곡 매칭은 여러 번 검증했지만 연도는 확인한 적이
없었고, 봄의 왈츠가 2005 로 적혀 있는 걸 우연히 발견했다.

받아온 문서는 파일에 남긴다. 중간에 막혀도 다시 받지 않는다.
"""
import json, os, re, sys, time, urllib.parse, urllib.request
sys.stdout.reconfigure(encoding='utf-8')

UA = {'User-Agent': 'music-year-game/1.0 (personal party game; contact via github)'}
API = 'https://ko.wikipedia.org/w/api.php?'
CACHE = os.path.join(os.environ.get('TMPDIR', '.'), 'wiki_cache.json')
cache = json.load(open(CACHE, encoding='utf-8')) if os.path.exists(CACHE) else {}

def fetch(titles):
    todo = [t for t in titles if t not in cache]
    for i in range(0, len(todo), 20):
        chunk = todo[i:i + 20]
        q = urllib.parse.urlencode({'action': 'query', 'prop': 'extracts', 'exintro': 1,
                                    'explaintext': 1, 'redirects': 1, 'format': 'json',
                                    'titles': '|'.join(chunk)})
        for attempt in range(5):
            try:
                d = json.load(urllib.request.urlopen(
                    urllib.request.Request(API + q, headers=UA), timeout=30))
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 4: raise
                wait = 10 * (attempt + 1)
                print(f'   (제한 걸림 — {wait}초 대기)', flush=True)
                time.sleep(wait)
        norm = {}
        for n in d['query'].get('normalized', []): norm[n['to']] = n['from']
        for r in d['query'].get('redirects', []): norm[r['to']] = norm.get(r['from'], r['from'])
        got = {}
        for p in d['query']['pages'].values():
            t = p.get('title')
            got[norm.get(t, t)] = p.get('extract') or ''
        for t in chunk: cache[t] = got.get(t, '')
        json.dump(cache, open(CACHE, 'w', encoding='utf-8'), ensure_ascii=False)
        print(f'   {min(i + 20, len(todo))}/{len(todo)}', flush=True)
        time.sleep(3)
    return {t: cache.get(t, '') for t in titles}

def is_disambig(t): return bool(re.search(r'(다음을 일컫는|동음이의|다음과 같다)', t[:120]))

def year_of(text):
    for sent in re.split(r'(?<=다\.)\s*|(?<=\.)\s+', text):
        if re.search(r'(방송|방영|개봉|공개)', sent):
            m = re.search(r'(19|20)\d{2}(?=년)', sent)
            if m: return int(m.group(0))
    m = re.search(r'(19|20)\d{2}(?=년)', text)
    return int(m.group(0)) if m else None

songs = json.load(open('data/ost.json', encoding='utf-8'))['songs']
works = {}
for s in songs: works.setdefault(s['work'].strip(), s)

print(f'■ 위키백과 조회 ({len(works)}편)')
texts = fetch(list(works))

retry, alts = [], {}
for w in works:
    if not texts.get(w) or is_disambig(texts[w]): retry.append(w)
for w in retry:
    kind = '드라마' if works[w]['workType'] == 'drama' else '영화'
    for suf in (f'{w} ({kind})', f"{w} ({works[w]['year']}년 {kind})"):
        alts[suf] = w
if alts:
    print(f'■ 동음이의 재조회 ({len(retry)}편)')
    for t, x in fetch(list(alts)).items():
        w = alts.get(t)
        if w and x and not is_disambig(x) and (not texts.get(w) or is_disambig(texts[w])):
            texts[w] = x

ok, diff, miss = [], [], []
for w, s in works.items():
    t = texts.get(w, '')
    y = None if (not t or is_disambig(t)) else year_of(t)
    if y is None: miss.append((w, s))
    elif y == s['year']: ok.append(w)
    else: diff.append((w, s, y, t[:110].replace('\n', ' ')))

print(f"\n일치 {len(ok)} · 불일치 {len(diff)} · 확인불가 {len(miss)}  (총 {len(works)}편)\n")
print('■ 연도가 다름')
for w, s, y, t in sorted(diff, key=lambda x: x[1]['year']):
    print(f"   {s['year']} → {y}  {w} ({'드라마' if s['workType']=='drama' else '영화'})")
    print(f"        {t}")
print('\n■ 위키백과에서 못 찾음')
for w, s in sorted(miss, key=lambda x: x[1]['year']):
    print(f"   {s['year']}  {w}")
json.dump({'diff': [[w, s['year'], y] for w, s, y, _ in diff],
           'miss': [[w, s['year']] for w, s in miss]},
          open('.year_audit.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
