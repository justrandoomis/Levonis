#!/usr/bin/env python3
"""Polite, resumable crawl of the Bambu Lab US store product pages (one-time import, DECISIONS row 239).
- >= 11 s between requests to us.store.bambulab.com (robots.txt Crawl-delay 10)
- only /products/<handle> URLs from the store's own sitemap (robots allows them)
- stops on a bot challenge (403 / 'Just a moment') — never bypassed
- stores gzip'd HTML at raw/<handle>.html.gz plus a JSONL log; skips pages already stored
"""
import gzip, json, os, re, sys, time, urllib.request, urllib.error, urllib.parse
P = os.path.dirname(os.path.abspath(__file__))
SITEMAP = os.path.join(os.path.dirname(P), 'products_sitemap.xml')
UA = 'Mozilla/5.0 (compatible; LevonisCatalogImport/1.0; +https://levonis-iq.com)'
LOG = os.path.join(P, 'crawl.log.jsonl')
GAP = 11.0
MAX_FETCH = int(os.environ.get('MAX_FETCH','0') or 0)
urls = re.findall(r'<loc>(https://us\.store\.bambulab\.com/products/[^<]+)</loc>', open(SITEMAP, encoding='utf-8').read())
seen = []
for u in urls:
    if u not in seen: seen.append(u)
urls = seen
def log(rec):
    with open(LOG, 'a') as f: f.write(json.dumps(rec) + '\n')
last = 0.0
done = skipped = 0
for i, u in enumerate(urls):
    handle = urllib.parse.unquote(u.rsplit('/products/', 1)[1]).strip('/')
    safe = re.sub(r'[^A-Za-z0-9._-]', '_', handle)
    out = os.path.join(P, 'raw', safe + '.html.gz')
    if MAX_FETCH and done >= MAX_FETCH:
        print('MAX_FETCH reached', done); break
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        skipped += 1; continue
    for attempt in range(5):
        wait = GAP - (time.time() - last)
        if wait > 0: time.sleep(wait)
        last = time.time()
        req = urllib.request.Request(u, headers={'User-Agent': UA, 'Accept': 'text/html'})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read(); status = r.status; final = r.geturl()
        except urllib.error.HTTPError as e:
            body = e.read() if hasattr(e, 'read') else b''; status = e.code; final = u
        except Exception as e:
            log({'i': i, 'url': u, 'err': str(e)[:200], 'attempt': attempt}); time.sleep(30 * (attempt + 1)); continue
        text_head = body[:4000].decode('utf-8', 'ignore')
        if status == 403 or 'Just a moment' in text_head:
            log({'i': i, 'url': u, 'status': status, 'blocked': True}); print('BLOCKED at', u, status); sys.exit(2)
        if status in (429, 500, 502, 503, 504):
            log({'i': i, 'url': u, 'status': status, 'retry': attempt}); time.sleep(60 * (attempt + 1)); continue
        rec = {'i': i, 'url': u, 'handle': handle, 'status': status, 'final': final, 'bytes': len(body), 'ts': time.time()}
        if status == 200:
            with gzip.open(out + '.tmp', 'wb') as f: f.write(body)
            os.replace(out + '.tmp', out)
        else:
            with open(os.path.join(P, 'raw', safe + '.status'), 'w') as f: f.write(json.dumps(rec))
        log(rec); done += 1
        break
    if done % 50 == 0 and done: print(time.strftime('%H:%M:%S'), 'fetched', done, 'skipped', skipped, 'of', len(urls), flush=True)
print('FINISHED fetched', done, 'skipped', skipped, 'total', len(urls))
