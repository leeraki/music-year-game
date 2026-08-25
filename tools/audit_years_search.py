"""연도를 못 찾은 작품을 위키백과 검색으로 다시 찾는다.

'도깨비'로 물으면 민담이, '주몽'으로 물으면 고구려 왕이 나온다. 제목만으로는
드라마 문서에 닿지 못하므로 검색을 거쳐 후보를 받아 그중에서 고른다.
"""
import json, os, re, sys, time, urllib.parse, urllib.request
sys.stdout.reconfigure(encoding='utf-8')

UA = {'User-Agent': 'music-year-game/1.0 (personal party game; contact via github)'}
API = 'https://ko.wikipedia.org/w/api.php?'
CACHE = os.path.join(os.environ.get('TMPDIR', '.'), 'wiki_search.json')
cache = json.load(open(CACHE, encoding='utf-8')) if os.path.exists(CACHE) else {}

def search_extracts(term):
    if term in cache: return cache[term]
    q = urllib.parse.urlencode({'action': 'query', 'generator': 'search', 'gsrsearch': term,
                                'gsrlimit': 5, 'prop': 'extracts', 'exintro': 1,
                                'explaintext': 1, 'format': 'json'})
    for attempt in range(5):
        try:
            d = json.load(urllib.request.urlopen(
                urllib.request.Request(API + q, headers=UA), timeout=30))
            break
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 4: raise
            time.sleep(10 * (attempt + 1))
    out = [{'title': p.get('title'), 'extract': p.get('extract') or ''}
           for p in d.get('query', {}).get('pages', {}).values()]
    cache[term] = out
    json.dump(cache, open(CACHE, 'w', encoding='utf-8'), ensure_ascii=False)
    time.sleep(2)
    return out

def year_of(text):
    for sent in re.split(r'(?<=다\.)\s*|(?<=\.)\s+', text):
        if re.search(r'(방송|방영|개봉|공개)', sent):
            m = re.search(r'(19|20)\d{2}(?=년)', sent)
            if m: return int(m.group(0))
    return None

songs = json.load(open('data/ost.json', encoding='utf-8'))['songs']
works = {}
for s in songs: works.setdefault(s['work'].strip(), s)
audit = json.load(open('.year_audit.json', encoding='utf-8'))
todo = [w for w, _ in audit['miss']] + [w for w, _, _ in audit['diff']]

print(f'■ 검색으로 재확인 ({len(todo)}편)')
res, still = [], []
for i, w in enumerate(todo, 1):
    s = works[w]
    kind = '드라마' if s['workType'] == 'drama' else '영화'
    hits = search_extracts(f'{w} {kind}')
    best = None
    for h in hits:
        # 제목이 작품명으로 시작하고, 그 매체를 설명하는 문서여야 한다
        if not h['title'].startswith(w[:4]): continue
        if not re.search(r'(드라마|영화|텔레비전|방송)', h['extract'][:300]): continue
        y = year_of(h['extract'])
        if not y: continue
        # 후보가 여럿이면 시드 연도에 가장 가까운 것을 고른다(시즌·리메이크 구분)
        if best is None or abs(y - s['year']) < abs(best[1] - s['year']):
            best = (h['title'], y, h['extract'][:120].replace('\n', ' '))
    if best: res.append((w, s['year'], best))
    else:    still.append((w, s['year']))
    if i % 15 == 0: print(f'   {i}/{len(todo)}', flush=True)

match = [r for r in res if r[1] == r[2][1]]
diff  = [r for r in res if r[1] != r[2][1]]
print(f'\n일치 {len(match)} · 불일치 {len(diff)} · 여전히 확인불가 {len(still)}\n')
print('■ 연도가 다름 — 고쳐야 할 후보')
for w, seed, (title, y, ex) in sorted(diff, key=lambda x: x[1]):
    print(f"   {seed} → {y}   {w}")
    print(f"        [{title}] {ex}")
print('\n■ 여전히 확인불가')
for w, y in still: print(f"   {y}  {w}")
json.dump({'diff': [[w, seed, b[1], b[0]] for w, seed, b in diff],
           'still': still}, open('.year_audit2.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
