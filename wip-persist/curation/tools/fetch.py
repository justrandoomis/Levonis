#!/usr/bin/env python3
"""Polite, sequential, resumable document fetcher for the Bambu curated scope (spec §F step 1, §J.2).

- one request at a time; per-host spacing persisted across runs (state file):
  wiki.bambulab.com >= 6 s, every CDN / other host >= 1.5 s;
- robots.txt of each host is read (and cached) before the first request to it, and obeyed;
- descriptive User-Agent, no cookies, redirects are NOT followed automatically (each hop is its own spaced request);
- a 403 challenge (cf-mitigated, "Just a moment", any 403 that is not an S3 AccessDenied XML) or a 429/503 stops the run;
- each URL is fetched once: the index (url -> file, text, bytes, sha256, content_type, status, fetched_at) is the resume key;
- PDFs get `pdftotext -layout` text next to them (<file>.txt); wiki HTML gets its page-content text (<file>.txt).

Usage: python3 -I fetch.py <queue.json>   (a JSON list of URLs or {"url", "method"} objects)
Exit codes: 0 done, 2 stopped on a challenge / rate limit.
"""
import gzip, hashlib, html, json, os, re, subprocess, sys, time, urllib.error, urllib.parse, urllib.request, urllib.robotparser

ROOT = '/tmp/claude-0/-home-user-Levonis/aa8068a2-6eee-5a26-9836-675f1c2740c2/scratchpad/curation'
DOCS = os.path.join(ROOT, 'docs')
ROBOTS = os.path.join(ROOT, 'robots')
INDEX = os.path.join(DOCS, 'index.json')
STATE = os.path.join(ROOT, 'fetch-state.json')
LOG = os.path.join(ROOT, 'fetch-log.jsonl')
UA = 'Mozilla/5.0 (compatible; LevonisCatalogImport/1.0; +https://levonis-iq.com)'
GAP = {'wiki.bambulab.com': 6.0}
DEFAULT_GAP = 1.5
NEVER = {'us.store.bambulab.com', 'store.bambulab.com', 'levonis-iq.com', 'www.levonis-iq.com'}
os.makedirs(DOCS, exist_ok=True)
os.makedirs(ROBOTS, exist_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(NoRedirect())


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def log(rec):
    rec['ts'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    with open(LOG, 'a') as f:
        f.write(json.dumps(rec) + '\n')


state = load(STATE, {'last': {}})
index = load(INDEX, {})


class Stop(Exception):
    pass


def wait_for(host):
    gap = GAP.get(host, DEFAULT_GAP)
    last = state['last'].get(host, 0.0)
    w = gap - (time.time() - last)
    if w > 0:
        time.sleep(w)
    state['last'][host] = time.time()
    save(STATE, state)


def raw_request(url, method='GET'):
    """One spaced request. Returns (status, headers, body)."""
    host = urllib.parse.urlsplit(url).hostname or ''
    if host in NEVER:
        raise Stop(f'refusing a never-fetch host: {host}')
    wait_for(host)
    req = urllib.request.Request(url, method=method, headers={'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'gzip'})
    try:
        with OPENER.open(req, timeout=60) as r:
            status, headers, body = r.status, r.headers, (r.read() if method != 'HEAD' else b'')
    except urllib.error.HTTPError as e:
        status, headers = e.code, e.headers
        try:
            body = e.read() if method != 'HEAD' else b''
        except Exception:
            body = b''
    if (headers.get('Content-Encoding') or '').lower() == 'gzip' and body:
        try:
            body = gzip.decompress(body)
        except Exception:
            pass
    head = body[:6000].decode('utf-8', 'ignore')
    s3_denied = status == 403 and '<Code>AccessDenied</Code>' in head and 'AmazonS3' in (headers.get('Server') or '')
    if headers.get('cf-mitigated') or 'Just a moment' in head or (status == 403 and not s3_denied):
        log({'url': url, 'status': status, 'challenge': True})
        raise Stop(f'challenge / 403 at {url} (status {status})')
    if status in (429, 503):
        log({'url': url, 'status': status, 'retry_after': headers.get('Retry-After')})
        raise Stop(f'rate limited at {url} (status {status}, Retry-After {headers.get("Retry-After")})')
    return status, headers, body


robots_cache = {}


def allowed(url):
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname
    if host not in robots_cache:
        rp = urllib.robotparser.RobotFileParser()
        path = os.path.join(ROBOTS, f'{host}.txt')
        meta = os.path.join(ROBOTS, f'{host}.status')
        if os.path.exists(meta) and open(meta).read().strip() == 'blocked':
            # the host answered 403 (not an S3 missing-object) to robots.txt: never contacted again, never bypassed
            rp.disallow_all = True
            robots_cache[host] = rp
            return False
        if os.path.exists(meta):
            st = int(open(meta).read().strip() or 0)
            txt = open(path, encoding='utf-8', errors='ignore').read() if os.path.exists(path) else ''
        else:
            st, _, body = raw_request(f'{parts.scheme}://{host}/robots.txt')
            txt = body.decode('utf-8', 'ignore') if st == 200 else ''
            open(path, 'w').write(txt)
            open(meta, 'w').write(str(st))
            log({'robots': host, 'status': st, 'bytes': len(txt)})
        if st == 200:
            rp.parse(txt.splitlines())
        elif 400 <= st < 500:
            rp.allow_all = True  # RFC 9309 §2.3.1.3: robots.txt unavailable -> no restriction
        else:
            rp.disallow_all = True
        robots_cache[host] = rp
    return robots_cache[host].can_fetch(UA, url)


def safe_name(url, ext):
    p = urllib.parse.urlsplit(url)
    host = {'store.bblcdn.com': 'bblcdn', 'store.bblcdn.eu': 'bblcdn-eu', 'wiki.bambulab.com': 'wiki', 'cdn.shopify.com': 'shopify',
            'public-cdn.bambulab.com': 'bbl-public', 'e.bambulab.com': 'tracker'}.get(p.hostname, re.sub(r'[^a-z0-9]+', '-', p.hostname or 'x'))
    path = urllib.parse.unquote(p.path)
    stem = path.rsplit('/', 1)[-1] if host != 'wiki' else path.strip('/').replace('/', '_')
    stem = re.sub(r'\.(pdf|html?)$', '', stem, flags=re.I)
    stem = re.sub(r'[^A-Za-z0-9._-]+', '_', stem).strip('._')[:80] or 'index'
    h = hashlib.sha1(url.encode()).hexdigest()[:8]
    return f'{host}__{stem}__{h}{ext}'


def wiki_text(body):
    s = body.decode('utf-8', 'ignore')
    m = re.search(r'<template slot="contents">(.*?)</template>', s, re.S)
    frag = m.group(1) if m else s
    frag = re.sub(r'<(script|style)\b.*?</\1>', ' ', frag, flags=re.S | re.I)
    frag = re.sub(r'</t[dh]>\s*', ' | ', frag, flags=re.I)
    frag = re.sub(r'</tr>|<br\s*/?>|</p>|</li>|</h[1-6]>|</div>|</table>', '\n', frag, flags=re.I)
    frag = re.sub(r'<h([1-6])[^>]*>', lambda mm: '\n' + '#' * int(mm.group(1)) + ' ', frag, flags=re.I)
    frag = re.sub(r'<li[^>]*>', '- ', frag, flags=re.I)
    frag = re.sub(r'<img[^>]*alt="([^"]*)"[^>]*>', r'[img: \1]', frag, flags=re.I)
    frag = re.sub(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', r'\2 <\1>', frag, flags=re.I | re.S)
    frag = re.sub(r'<[^>]+>', '', frag)
    frag = html.unescape(frag)
    lines = [re.sub(r'[ \t ]+', ' ', ln).strip() for ln in frag.split('\n')]
    out, blank = [], 0
    for ln in lines:
        if not ln:
            blank += 1
            if blank > 1:
                continue
        else:
            blank = 0
        out.append(ln)
    title = re.search(r'<title>(.*?)</title>', s, re.S)
    head = f'TITLE: {html.unescape(title.group(1).strip()) if title else ""}\n\n'
    return head + '\n'.join(out).strip() + '\n'


def fetch(url, method='GET'):
    if url in index and index[url].get('status') is not None:
        return 'cached'
    if not allowed(url):
        h = urllib.parse.urlsplit(url).hostname
        blocked = os.path.exists(os.path.join(ROBOTS, f'{h}.status')) and open(os.path.join(ROBOTS, f'{h}.status')).read().strip() == 'blocked'
        index[url] = {'status': None, 'robots_disallowed': not blocked, 'host_blocked_403': blocked, 'fetched_at': None}
        save(INDEX, index)
        log({'url': url, 'robots_disallowed': True})
        return 'robots'
    hops, cur = [], url
    for _ in range(4):
        status, headers, body = raw_request(cur, method)
        log({'url': cur, 'status': status, 'bytes': len(body), 'method': method})
        if status in (301, 302, 303, 307, 308) and headers.get('Location'):
            loc = urllib.parse.urljoin(cur, headers['Location'])
            hops.append({'from': cur, 'status': status, 'location': loc})
            if method == 'HEAD':  # tracker: never followed
                break
            lh = urllib.parse.urlsplit(loc).hostname
            if lh in NEVER or lh != urllib.parse.urlsplit(cur).hostname or not allowed(loc):
                break
            cur = loc
            continue
        break
    rec = {'status': status, 'final_url': cur, 'redirects': hops, 'content_type': headers.get('Content-Type', ''),
           'fetched_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'method': method}
    if method == 'GET' and status == 200 and body:
        is_pdf = body[:5] == b'%PDF-' or 'pdf' in rec['content_type'].lower()
        ext = '.pdf' if is_pdf else ('.html' if 'html' in rec['content_type'].lower() else '.bin')
        name = safe_name(url, ext)
        fp = os.path.join(DOCS, name)
        with open(fp + '.tmp', 'wb') as f:
            f.write(body)
        os.replace(fp + '.tmp', fp)
        rec.update({'file': fp, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
        txt = fp + '.txt'
        if is_pdf:
            r = subprocess.run(['pdftotext', '-layout', fp, txt], capture_output=True, text=True, timeout=120)
            rec['text'] = txt if r.returncode == 0 and os.path.exists(txt) else None
            if r.returncode:
                rec['text_error'] = r.stderr[:300]
        elif ext == '.html':
            with open(txt, 'w') as f:
                f.write(wiki_text(body))
            rec['text'] = txt
    index[url] = rec
    save(INDEX, index)
    return status


def main():
    q = json.load(open(sys.argv[1]))
    n = 0
    try:
        for item in q:
            url, method = (item, 'GET') if isinstance(item, str) else (item['url'], item.get('method', 'GET'))
            r = fetch(url, method)
            if r != 'cached':
                n += 1
                print(time.strftime('%H:%M:%S'), r, url, flush=True)
    except Stop as e:
        print('STOPPED:', e, flush=True)
        sys.exit(2)
    print('DONE fetched', n, 'index size', len(index), flush=True)


if __name__ == '__main__':
    main()
