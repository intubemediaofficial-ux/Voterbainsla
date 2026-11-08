# Downloads every ward roll PDF for Karauli and Sawai Madhopur from SEC Rajasthan (reachable only from India, so via free India proxies).
# Writes <SEC_ROOT>/<dist>/<ps>/<gp>-W<ward>.pdf plus a <gp>.json manifest per GP, which scripts/sec-feed.js queues for OCR.
import re, random, json, os, sys, time, html, threading, requests
from concurrent.futures import ThreadPoolExecutor
requests.packages.urllib3.disable_warnings()
URL = 'https://sec.rajasthan.gov.in/SE_PDFDownload.aspx'
P = 'ctl00$ContentPlaceHolder1$'
ROOT = os.environ.get('SEC_ROOT', '/home/ubuntu/sec/pdf')
PROX = [l.split()[0].replace('socks5://', 'socks5h://') for l in open(os.environ['SEC_PROXIES'])] if os.environ.get('SEC_PROXIES') else []
FAIL = {}
GEONODE = 'https://proxylist.geonode.com/api/proxy-list?country=IN&limit=200&page=1&sort_by=lastChecked&sort_type=desc'
SRC = ['https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/IN/data.txt',
       'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=in&protocol=http&proxy_format=protocolipport&format=text&timeout=10000',
       'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=in&protocol=socks4,socks5&proxy_format=protocolipport&format=text&timeout=10000']
def test(p):
    try:
        r = requests.get(URL, proxies={'http': p, 'https': p}, timeout=20, verify=False)
        return r.status_code == 200 and b'__VIEWSTATE' in r.content
    except Exception: return False
def refresh():
    cand = set(PROX)
    for u in SRC:
        try: cand |= {l.strip().replace('socks5://', 'socks5h://') for l in requests.get(u, timeout=30).text.split() if '://' in l}
        except Exception: pass
    try:
        for x in requests.get(GEONODE, timeout=30).json()['data']:
            for pr in x['protocols']: cand.add(f"{pr.replace('socks5', 'socks5h')}://{x['ip']}:{x['port']}")
    except Exception: pass
    with ThreadPoolExecutor(40) as ex: ok = [p for p, g in zip(cand, ex.map(test, cand)) if g]
    if ok:
        PROX[:] = ok
        for p in ok: FAIL[p] = 0
    print('PROXIES', len(ok), flush=True)
def refresher():
    while True:
        time.sleep(1200); refresh()
lock = threading.Lock()
def log(*a):
    with lock: print(*a, flush=True)
def form(t): return {m[0]: html.unescape(m[1]) for m in re.findall(r'<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"', t)}
def opts(t, id):
    m = re.search(r'<select[^>]*id="%s"[^>]*>(.*?)</select>' % id, t, re.S)
    return [(v, html.unescape(n).strip()) for v, n in re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)', m.group(1)) if v and v != '0'] if m else []
def rows(t):
    m = re.search(r'<table[^>]*GridViewPRI.*?</table>', t, re.S)
    if not m: return []
    out = []
    for r in re.findall(r'<tr class="gridRow.*?</tr>', m.group(0), re.S):
        tds = [re.sub('<[^>]+>', '', x).strip() for x in re.findall(r'<td[^>]*>(.*?)</td>', r, re.S)]
        tg = re.findall(r'PostBackOptions\(&quot;([^&]+)&quot;', r)
        if tg: out.append((html.unescape(tds[0]) if tds else '', tds[1] if len(tds) > 1 else '', tg[-1]))
    return out
class S:
    def __init__(s): s.s = requests.Session(); s.s.headers['User-Agent'] = 'Mozilla/5.0'
    def req(s, m, pdf=False, url=URL, **kw):
        for p in sorted(random.sample(PROX, len(PROX)), key=lambda p: FAIL.get(p, 0)) * 3:
            try:
                r = s.s.request(m, url, proxies={'http': p, 'https': p}, timeout=45, verify=False, **kw)
                if r.status_code != 200: FAIL[p] = FAIL.get(p, 0) + 1; continue
                if pdf:
                    if r.content[:4] == b'%PDF': return r
                    if url == URL and b"window.open('http" in r.content: return r
                    continue
                if len(r.content) > 5000 and b'__VIEWSTATE' in r.content: return r
            except Exception: FAIL[p] = FAIL.get(p, 0) + 1
        raise RuntimeError('all proxies failed')
    def post(s, t, vals, target='', pdf=False):
        d = form(t); d['__EVENTTARGET'] = target; d['__EVENTARGUMENT'] = ''
        d.update({P + k: v for k, v in vals.items()})
        r = s.req('POST', data=d, pdf=pdf)
        if pdf and r.content[:4] != b'%PDF':
            u = re.search(r"window\.open\('(https?://[^']+\.pdf)'", r.text).group(1)
            return s.req('GET', pdf=True, url=requests.utils.requote_uri(u)).content
        return r.content if pdf else r.text
def work(job):
    dist, dname, ps, psn = job
    for attempt in range(3):
        try:
            s = S(); t = s.req('GET').text
            t = s.post(t, {'DistrictDropDown': dist}, P + 'DistrictDropDown')
            t2 = s.post(t, {'DistrictDropDown': dist, 'PSDropDown': ps}, P + 'PSDropDown')
            gps = opts(t2, 'ContentPlaceHolder1_GPDropDown')
            log('PS', dname, psn, len(gps))
            for gp, gpn in gps:
                mf = f'{ROOT}/{dist}/{ps}/{gp}.json'
                if os.path.exists(mf): continue
                base = {'DistrictDropDown': dist, 'PSDropDown': ps, 'GPDropDown': gp}
                tr = s.post(t2, dict(base, SearchButton='Search'))
                rs = rows(tr)
                os.makedirs(os.path.dirname(mf), exist_ok=True)
                wards = []
                for hi, ward, target in rs:
                    f = f'{ROOT}/{dist}/{ps}/{gp}-W{ward.zfill(3)}.pdf'
                    if not os.path.exists(f):
                        b = s.post(tr, base, target, pdf=True)
                        open(f + '.tmp', 'wb').write(b); os.rename(f + '.tmp', f)
                    wards.append({'ward': ward, 'file': f, 'bytes': os.path.getsize(f)})
                json.dump({'dist': dist, 'district': dname, 'ps': ps, 'samiti': psn, 'gp': gp, 'name': gpn, 'hi': rs[0][0] if rs else '', 'wards': wards}, open(mf, 'w'), ensure_ascii=False)
                log('GP', dname, psn, gpn, len(wards))
            return
        except Exception as e:
            log('ERR', dname, psn, attempt, e)
            time.sleep(20)
if __name__ == '__main__':
    log('START'); refresh(); threading.Thread(target=refresher, daemon=True).start()
    s = S(); t0 = s.req('GET').text; jobs = []
    for dist, dname in [('23', 'Karauli'), ('29', 'Sawai Madhopur')]:
        t = s.post(t0, {'DistrictDropDown': dist}, P + 'DistrictDropDown')
        for ps, psn in opts(t, 'ContentPlaceHolder1_PSDropDown'):
            if 'PANCHAYAT SAMITI' in psn: jobs.append((dist, dname, ps, psn))
    log('START')
    log('JOBS', len(jobs), [j[3] for j in jobs])
    with ThreadPoolExecutor(8) as ex: list(ex.map(work, jobs))
    log('ALL DONE')
    while True:
        time.sleep(6 * 3600); list(ThreadPoolExecutor(8).map(work, jobs))
