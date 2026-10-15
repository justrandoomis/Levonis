"""Parse every crawled page into work/parsed/<file>.json (price-free closed extraction). Usage: python3 -I tools/parse_all.py"""
import gzip, json, os, sys, time
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import parse_page as pp
P0 = os.path.dirname(HERE)
RAW = os.path.join(P0, 'raw'); OUT = os.path.join(P0, 'work', 'parsed')
os.makedirs(OUT, exist_ok=True)

def one(fn):
    base = fn[:-len('.html.gz')]
    try:
        html = gzip.open(os.path.join(RAW, fn)).read().decode('utf-8', 'replace')
        r = pp.parse(html)
        r['_file'] = base
        json.dump(r, open(os.path.join(OUT, base + '.json'), 'w'), ensure_ascii=False)
        return base, r.get('desc_kind'), None
    except Exception as e:
        return base, None, repr(e)[:300]

if __name__ == '__main__':
    files = sorted(f for f in os.listdir(RAW) if f.endswith('.html.gz'))
    t = time.time()
    with Pool(4) as pool:
        res = pool.map(one, files, chunksize=8)
    import collections
    print('pages', len(res), 'secs', round(time.time() - t))
    print(collections.Counter(k for _, k, _ in res))
    errs = [(b, e) for b, _, e in res if e]
    print('errors', len(errs)); [print(' ', b, e) for b, e in errs[:20]]
