#!/usr/bin/env python3
"""CLI de leads do Google Maps: transforma um termo de busca e um lugar em um CSV com os 8 campos de lead.

Usa só a biblioteca padrão do Python (nada de pip install) e controla o motor local do projeto.

Um termo:
    python3 scripts/scrape.py "academias em Curitiba PR" -25.4284 -49.2733 --depth 5

Geocodificação automática (sem coordenadas):
    python3 scripts/scrape.py "cafeterias em Belo Horizonte MG" --city "Belo Horizonte, MG" --depth 5

Lote (um job, vários termos) a partir de um arquivo (um termo por linha):
    python3 scripts/scrape.py --keywords-file examples/queries.example.txt --city "São Paulo, SP"

Cidade inteira, além do limite de ~120 resultados por busca do Google (3 x 3 blocos do mapa,
um de cada vez, sem duplicatas por place_id):
    python3 scripts/scrape.py "encanadores em Campinas SP" --city "Campinas, SP" --grid 3

Pular a segunda passada de e-mails nas páginas de contato/sobre (ligada por padrão quando há e-mails):
    python3 scripts/scrape.py "academias em Curitiba PR" --city "Curitiba, PR" --no-deep-emails

Notas:
- A API exige: keywords, lat/lon (strings) e max_time (SEGUNDOS). Este script preenche tudo.
- A geocodificação usa o OpenStreetMap Nominatim (grátis, sem chave). Ele permite ~1 requisição/s e
  exige um User-Agent descritivo (definido abaixo). Não faça loops agressivos nele.

Baseado no Google Maps Scraper Kit (MIT, (c) 2026 Mahan). Veja CREDITS.md.
"""
import argparse, csv, functools, io, json, math, os, re, sys, time, urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor

ENV_KEYS = ("SCRAPER_BASE_URL", "SCRAPER_PORT", "SCRAPER_API_KEY")


def load_env_file():
    """Lê SCRAPER_* do .env do projeto, o mesmo arquivo que o docker compose lê, para que trocar a
    porta exija uma única edição. Variáveis já definidas no ambiente têm prioridade sobre o arquivo."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, ".env")
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                k, sep, v = line.strip().partition("=")
                if sep and k in ENV_KEYS and k not in os.environ:
                    os.environ[k] = v.strip().strip("\"'")
    except OSError:
        pass


load_env_file()
BASE = os.environ.get("SCRAPER_BASE_URL") or f"http://localhost:{os.environ.get('SCRAPER_PORT') or '8080'}"
KEY = os.environ.get("SCRAPER_API_KEY", "")
# Os 8 campos de lead: o que você usa para contatar e qualificar um lead.
# Todo o resto (coordenadas, IDs, horários, imagens, avaliações) é descartado por padrão.
LEAD = ["title", "phone", "emails", "website", "category", "address", "review_rating", "review_count"]
SOCIALS = ["instagram", "facebook", "linkedin", "whatsapp"]
UA = "leadsNEGOCIOS/1.0 (https://github.com/tzydit/leadsNEGOCIOS)"


def req(method, path, body=None):
    headers = {"Content-Type": "application/json", "User-Agent": UA}
    if KEY:
        headers["X-API-Key"] = KEY
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=60) as resp:
        return resp.status, resp.read()


def geocode(place, with_bbox=False):
    """Nome de cidade/lugar -> ('lat','lon') como strings via Nominatim, ou None.
    with_bbox=True devolve ('lat','lon', [sul, norte, oeste, leste])."""
    q = urllib.parse.urlencode({"format": "json", "limit": 1, "q": place})
    url = f"https://nominatim.openstreetmap.org/search?{q}"
    r = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            hits = json.loads(resp.read())
        time.sleep(1)  # respeita a política de ~1 req/s do Nominatim
        if hits:
            ll = (str(hits[0]["lat"]), str(hits[0]["lon"]))
            return ll + (hits[0].get("boundingbox"),) if with_bbox else ll
    except Exception as e:
        print(f"  (falha na geocodificação: {e})", file=sys.stderr)
    return None


def grid_cells(bbox, n):
    """Divide um bbox do Nominatim [sul, norte, oeste, leste] em n x n blocos -> [{lat, lon, radius, zoom}].
    radius (m) = 1,15 x metade da diagonal do bloco (equirretangular), no mínimo 1000.
    zoom = o zoom do Maps cuja janela de ~1000px tem mais ou menos a largura do bloco (11..17), para que
    cada busca comece olhando para o próprio bloco, e não para a cidade inteira ou um quarteirão."""
    s, nn, w, e = (float(x) for x in bbox)
    dlat, dlon = (nn - s) / n, (e - w) / n
    m_per_deg = 6371000 * math.pi / 180
    cells = []
    for i in range(n):
        for j in range(n):
            lat, lon = s + (i + 0.5) * dlat, w + (j + 0.5) * dlon
            cos = math.cos(math.radians(lat))
            width = max(1.0, dlon * m_per_deg * cos)
            diag = math.hypot(dlat * m_per_deg, width)
            zoom = round(math.log2(156543.03 * cos * 1000 / width))  # 156543 m/px no zoom 0
            cells.append({"lat": f"{lat:.6f}", "lon": f"{lon:.6f}",
                          "radius": max(1000, math.ceil(1.15 * diag / 2)),
                          "zoom": min(17, max(11, zoom))})
    return cells


def in_bbox(row, bbox, margin=0.10):
    """True se latitude/longitude da linha estão dentro do bbox [sul, norte, oeste, leste] ampliado em
    `margin` do seu tamanho em cada lado. Linhas sem coordenadas utilizáveis são mantidas (True)."""
    try:
        lat, lon = float(row.get("latitude")), float(row.get("longitude"))
    except (TypeError, ValueError):
        return True
    s, n, w, e = (float(x) for x in bbox)
    my, mx = (n - s) * margin, (e - w) * margin
    return s - my <= lat <= n + my and w - mx <= lon <= e + mx


def dedupe(rows):
    """Mantém a primeira linha por place_id, senão cid, senão link, senão título+endereço."""
    seen, out = set(), []
    for r in rows:
        key = next((f"{k}:{r[k]}" for k in ("place_id", "cid", "link") if r.get(k)),
                   f"ta:{r.get('title', '')}|{r.get('address', '')}")
        if key not in seen:
            seen.add(key); out.append(r)
    return out


def run_job(body):
    """Cria um job no motor, acompanha e baixa -> (job_id, linhas do CSV bruto). Levanta RuntimeError."""
    try:
        _, raw = req("POST", "/api/v1/jobs", body)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"✗ Falha ao criar o job: HTTP {e.code} — {e.read().decode()[:200]}")
    job_id = json.loads(raw).get("id")
    if not job_id:
        raise RuntimeError("✗ Nenhum id de job retornado.")
    print(f"  id do job: {job_id}")

    print("▶ Acompanhando…")
    status = None
    for i in range(120):
        _, raw = req("GET", f"/api/v1/jobs/{job_id}")
        status = json.loads(raw).get("Status")
        print(f"\r  status: {str(status):<10} (tentativa {i + 1})", end="", flush=True)
        if status == "ok":
            print(); break
        if status == "failed":
            raise RuntimeError("\n✗ O job falhou. Se continuar acontecendo, seu IP pode estar limitado — "
                               "espere ou use proxies.")
        time.sleep(8)
    else:
        raise RuntimeError("\n✗ Tempo esgotado.")

    _, raw = req("GET", f"/api/v1/jobs/{job_id}/download")
    return job_id, list(csv.DictReader(io.StringIO(raw.decode("utf-8", "replace"))))


def collect_keywords(a):
    kws = []
    if a.keyword:
        kws.append(a.keyword)
    kws.extend(a.also or [])
    if a.keywords_file:
        with open(a.keywords_file, encoding="utf-8") as f:
            kws.extend(line.strip() for line in f if line.strip() and not line.startswith("#"))
    # remove duplicatas mantendo a ordem
    seen, out = set(), []
    for k in kws:
        if k not in seen:
            seen.add(k); out.append(k)
    return out


# ── Enriquecimento social opcional (Instagram / Facebook / LinkedIn / WhatsApp) ──
# Puro código (HTTP + regex) → ZERO tokens de IA. Visita o site de cada empresa uma vez.
SOCIAL_RE = {
    "instagram": re.compile(r"https?://(?:www\.)?instagram\.com/([A-Za-z0-9_.]+)", re.I),
    "facebook":  re.compile(r"https?://(?:www\.|m\.|web\.|[a-z]{2}-[a-z]{2}\.)?facebook\.com/([A-Za-z0-9_.\-]+)", re.I),
    "linkedin":  re.compile(r"https?://(?:[a-z]{2,3}\.)?linkedin\.com/(?:company|in|school)/([A-Za-z0-9_.\-%]+)", re.I),
}
# Links de WhatsApp que sites brasileiros costumam usar: wa.me/<número>,
# api.whatsapp.com/send?phone=<número> e whatsapp://send?phone=<número>.
WHATSAPP_RE = re.compile(
    r"(?:https?://)?(?:wa\.me/|(?:api|web)\.whatsapp\.com/send/?\?(?:[^\"'\s<>]*?&(?:amp;)?)?phone=|"
    r"whatsapp://send/?\?(?:[^\"'\s<>]*?&(?:amp;)?)?phone=)\+?([0-9][0-9 ()\-.]{7,20}[0-9])", re.I)
_SKIP_HANDLE = {"", "home", "pages", "people", "help", "about", "policies", "policy",
                "legal", "tos", "privacy", "settings", "sharer", "tr", "profile.php", "sharer.php",
                "plugins", "dialog", "intent", "login", "share.php", "permalink.php",
                "p", "reel", "reels", "explore", "stories", "tv", "watch", "events",
                "groups", "marketplace", "gaming", "photo", "hashtag", "search"}

def _fetch_html(url, timeout=10):
    if not url:
        return ""
    if not url.startswith(("http://", "https://")):
        url = "http://" + url
    try:
        r = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; " + UA + ")", "Accept": "text/html"})
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.read(400_000).decode("utf-8", "replace")
    except Exception:
        return ""

@functools.lru_cache(maxsize=512)  # só páginas iniciais; as que saírem do cache são buscadas de novo
def _fetch_cached(url):
    """Busca da página inicial compartilhada pela passada de e-mails e por --socials (uma por site)."""
    return _fetch_html(url, timeout=8)

def _find_whatsapp(html):
    """Primeiro número de WhatsApp linkado na página -> 'https://wa.me/<dígitos>', ou ''."""
    for m in WHATSAPP_RE.finditer(html or ""):
        digits = re.sub(r"\D", "", m.group(1))
        if 10 <= len(digits) <= 15:
            return f"https://wa.me/{digits}"
    return ""

def _find_socials(html):
    out = {"instagram": "", "facebook": "", "linkedin": ""}
    for plat, rx in SOCIAL_RE.items():
        for m in rx.finditer(html or ""):
            h = m.group(1).lower()
            if h in _SKIP_HANDLE:
                continue
            if plat == "facebook" and (h.isdigit() or len(h) < 3):  # ignora lixo como /2008
                continue
            out[plat] = m.group(0).rstrip('"\'/').replace("\\", "")
            break
    out["whatsapp"] = _find_whatsapp(html)
    return out

def enrich_socials(results, workers=8):
    """Adiciona instagram/facebook/linkedin/whatsapp a cada lead lendo o site. Zero tokens de IA."""
    for r in results:                       # garante que toda linha tenha as chaves
        for k in SOCIALS:
            r.setdefault(k, "")
    todo = [r for r in results if r.get("website")]
    done = 0
    def work(r):
        r.update(_find_socials(_fetch_cached(r["website"])))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for _ in ex.map(work, todo):
            done += 1
            print(f"\r  redes sociais: {done}/{len(todo)} sites verificados", end="", flush=True)
    print()


# ── Passada profunda de e-mails: páginas de contato/sobre para linhas que o motor deixou sem e-mail ──
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
MAILTO_RE = re.compile(r"mailto:([^\"'>\s?]+)", re.I)
HREF_RE = re.compile(r"<a\s[^>]*?href\s*=\s*[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", re.I | re.S)
_JUNK_EXT = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js")
_JUNK_DOMAIN = ("example", "sentry", "wixpress", "wix.com", "godaddy", "squarespace", "wordpress",
                "domain.com", "email.com", "yourdomain", "seudominio", "seusite", "schema.org",
                "w3.org", "sentry.io")
_JUNK_LOCAL = {"name", "email", "user", "you", "someone", "nome", "seuemail", "usuario", "fulano"}
# Palavras que indicam páginas de contato/sobre, em inglês e português.
CONTACT_WORDS = re.compile(r"contact|about|contato|fale|sobre|quem-somos|quem somos|atendimento", re.I)
CONTACT_PATHS = ("/contato", "/fale-conosco", "/contact", "/sobre", "/quem-somos", "/about")

def _host(url):
    if not url.startswith(("http://", "https://")):
        url = "http://" + url
    h = (urllib.parse.urlparse(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h

def extract_emails(html, site_host):
    """E-mails de links mailto: e do texto, sem lixo, os do domínio do site primeiro, no máximo 3."""
    site = _host(site_host or "")
    found = []
    for e in MAILTO_RE.findall(html or "") + EMAIL_RE.findall(html or ""):
        e = urllib.parse.unquote(e).strip().lower()
        local, _, dom = e.rpartition("@")
        if (not EMAIL_RE.fullmatch(e) or e.endswith(_JUNK_EXT) or local in _JUNK_LOCAL
                or any(j in dom for j in _JUNK_DOMAIN) or e in found):
            continue
        found.append(e)
    on_site = lambda e: site and (e.endswith("@" + site) or e.endswith("." + site))
    return sorted(found, key=lambda e: not on_site(e))[:3]

def contact_links(html, base_url):
    """Até 3 URLs de contato/sobre do mesmo site: links encontrados primeiro, depois caminhos fixos."""
    if not base_url.startswith(("http://", "https://")):
        base_url = "http://" + base_url
    host, out = _host(base_url), []
    for href, text in HREF_RE.findall(html or ""):
        if not CONTACT_WORDS.search(href + " " + text):
            continue
        url = urllib.parse.urldefrag(urllib.parse.urljoin(base_url, href.strip()))[0]
        if url.startswith(("http://", "https://")) and _host(url) == host and url not in out:
            out.append(url)
    for path in CONTACT_PATHS:
        url = urllib.parse.urljoin(base_url, path)
        if len(out) < 3 and url not in out:
            out.append(url)
    return out[:3]

def enrich_emails(results, workers=8):
    """Preenche `emails` vazios pela página inicial e depois até 3 páginas de contato/sobre. Zero tokens de IA."""
    todo = [r for r in results if r.get("website") and not r.get("emails")]
    done = 0
    def work(r):
        site = r["website"]
        home = _fetch_cached(site)
        found = extract_emails(home, site)
        if home and not found:
            pages = "".join(_fetch_html(u, timeout=8) for u in contact_links(home, site))
            found = extract_emails(pages, site)
        r["emails"] = ", ".join(found)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for _ in ex.map(work, todo):
            done += 1
            print(f"\r  e-mails: {done}/{len(todo)} sites verificados", end="", flush=True)
    print()


def main():
    ap = argparse.ArgumentParser(description="Extrai empresas do Google Maps como leads.")
    ap.add_argument("keyword", nargs="?", help='ex.: "dentistas em São Paulo SP"')
    ap.add_argument("lat", nargs="?", help="latitude (opcional se usar --city)")
    ap.add_argument("lon", nargs="?", help="longitude (opcional se usar --city)")
    ap.add_argument("--keyword", dest="also", action="append", help="termo extra (pode repetir)")
    ap.add_argument("--keywords-file", help="arquivo com um termo por linha (lote)")
    ap.add_argument("--city", help="cidade/lugar para geocodificar lat/lon automaticamente")
    ap.add_argument("--depth", type=int, default=5)
    ap.add_argument("--lang", default="pt",
                    help="idioma de 2 letras dos resultados do Google Maps (padrão: pt; ex.: en, es)")
    # E-mails LIGADOS por padrão (são o campo de lead mais valioso). O motor visita o site de cada
    # empresa para achar um endereço — um pouco mais lento. Use --no-email para uma execução rápida.
    ap.add_argument("--email", dest="email", action="store_true", default=True, help=argparse.SUPPRESS)
    ap.add_argument("--no-email", dest="email", action="store_false",
                    help="pula a extração de e-mails para rodar mais rápido (ligada por padrão)")
    ap.add_argument("--no-deep-emails", dest="deep_emails", action="store_false",
                    help="pula a segunda passada de e-mails em páginas de contato/sobre (ligada com e-mails)")
    ap.add_argument("--grid", type=int, metavar="N",
                    help="divide a área de --city em N x N blocos do mapa, um job cada, sem duplicatas "
                         "(passa do limite de ~120 por busca do Google; máx. 10)")
    ap.add_argument("--max-time", type=int, default=600, help="limite de tempo do job em SEGUNDOS")
    ap.add_argument("--out", default=None, help="arquivo de saída (padrão: results-<id>.csv). "
                    "A extensão define o formato: .csv (padrão) ou .json")
    ap.add_argument("--json", action="store_true", help="grava JSON em vez do CSV padrão")
    ap.add_argument("--full", action="store_true", help="mantém TODAS as colunas brutas (padrão: campos de lead)")
    ap.add_argument("--fields", help="colunas separadas por vírgula (substitui os campos de lead padrão)")
    ap.add_argument("--socials", action="store_true",
                    help="também busca Instagram/Facebook/LinkedIn/WhatsApp no site de cada empresa "
                         "(0 tokens de IA; mais lento)")
    a = ap.parse_args()

    keywords = collect_keywords(a)
    if not keywords:
        sys.exit("✗ Nenhum termo. Passe um termo, --keyword ou --keywords-file.")

    if a.grid is not None:
        if not a.city:
            sys.exit("✗ --grid precisa de --city: é o retângulo da cidade que é dividido em blocos.")
        if not 1 <= a.grid <= 10:
            sys.exit("✗ --grid deve estar entre 1 e 10 (10 x 10 = 100 jobs é o teto).")

    # Coordenadas: lat/lon explícitos, senão geocodifica --city, senão o primeiro termo.
    # --grid sempre geocodifica --city, porque precisa do retângulo da cidade.
    lat, lon = a.lat, a.lon
    if a.grid:
        print(f"▶ Geocodificando \"{a.city}\"…")
        geo = geocode(a.city, with_bbox=True)
        if not geo or not geo[2]:
            sys.exit("✗ Não foi possível obter o retângulo da cidade. Tente um --city mais claro.")
        lat, lon, bbox = geo
        cells = grid_cells(bbox, a.grid)
        print(f"  → bbox S{bbox[0]} N{bbox[1]} O{bbox[2]} L{bbox[3]}, {len(cells)} blocos")
    elif not (lat and lon):
        place = a.city or keywords[0]
        print(f"▶ Geocodificando \"{place}\"…")
        coords = geocode(place)
        if not coords:
            sys.exit("✗ Não foi possível obter as coordenadas. Passe lat/lon ou um --city mais claro.")
        lat, lon = coords
        print(f"  → {lat}, {lon}")

    if a.email:
        print("ℹ Extração de e-mails LIGADA (visita o site de cada empresa; um pouco mais lento). "
              "Use --no-email para rodar rápido.")

    # --- AVISA, não bloqueia: sinaliza jobs grandes (e segue em frente) ---
    if a.depth >= 15 or len(keywords) >= 10 or (a.grid or 1) ** 2 >= 4:
        print("⚠️  Atenção: este é um job grande (depth alto, muitos termos ou grid).")
        print("    Rodar isso em sequência sem proxies pode fazer o Google limitar seu IP temporariamente")
        print("    (passa em minutos ou horas; enquanto isso, jobs voltam vazios ou falham). Para execuções")
        print("    grandes ou repetidas, use proxies. Continuando…\n")

    # Verificação de saúde
    try:
        req("GET", "/api/v1/jobs")
    except Exception as e:
        sys.exit(f"✗ Motor não acessível em {BASE} — rode 'docker compose up -d' primeiro.\n  ({e})")

    body = {"name": "leads-py", "keywords": keywords, "lang": a.lang, "zoom": 15,
            "lat": str(lat), "lon": str(lon), "fast_mode": False, "radius": 10000,
            "depth": a.depth, "email": a.email, "max_time": a.max_time}
    if not a.grid:
        print(f"▶ Criando job: {len(keywords)} termo(s) @ {lat},{lon} depth={a.depth} email={a.email}")
        for k in keywords:
            print(f"    • {k}")
        try:
            job_id, rows = run_job(body)
        except RuntimeError as e:
            sys.exit(str(e))
    else:
        print(f"▶ Grid {a.grid}x{a.grid}: {len(cells)} jobs, um de cada vez, "
              f"{len(keywords)} termo(s) depth={a.depth} email={a.email}")
        for k in keywords:
            print(f"    • {k}")
        job_id, rows = None, []
        for i, cell in enumerate(cells, 1):  # sequencial de propósito: nunca jobs paralelos contra o Google
            print(f"▶ Bloco {i}/{len(cells)} @ {cell['lat']},{cell['lon']} raio={cell['radius']}m")
            try:
                jid, cell_rows = run_job(dict(body, **cell))
            except Exception as e:
                print(f"\n  ⚠ bloco {i}/{len(cells)} ignorado: {str(e).strip()}")
                continue
            job_id = job_id or jid
            rows = dedupe(rows + cell_rows)
            print(f"  bloco {i}/{len(cells)}: {len(cell_rows)} linhas, {len(rows)} únicas até agora")
        if job_id is None:
            sys.exit("✗ Todos os blocos falharam. Seu IP pode estar limitado — espere ou use proxies.")
        # radius não corta resultados no modo normal, então blocos vazam para fora da cidade
        kept = [r for r in rows if in_bbox(r, bbox)]
        print(f"  descartadas {len(rows) - len(kept)} linhas fora do retângulo da cidade")
        rows = kept
    if a.full:
        fields = list(rows[0].keys()) if rows else LEAD
    elif a.fields:
        fields = [c.strip() for c in a.fields.split(",") if c.strip()]
    else:
        fields = LEAD
    results = [{k: r.get(k, "") for k in fields} for r in rows]
    print(f"✓ Pronto — {len(results)} empresas (campos: {', '.join(fields)}).")

    if a.email and a.deep_emails and "emails" in fields:
        print("▶ Passada profunda de e-mails: verificando páginas de contato/sobre das linhas sem e-mail…")
        engine = sum(1 for r in results if r.get("emails"))
        enrich_emails(results)
        total = sum(1 for r in results if r.get("emails"))
        n = len(results)
        print(f"  e-mails: {engine}/{n} do motor, +{total - engine} das páginas de contato "
              f"= {total}/{n} ({round(100 * total / n) if n else 0}%)")

    if a.socials:
        print("▶ Buscando redes sociais (Instagram / Facebook / LinkedIn / WhatsApp) em cada site…")
        print("  ℹ Custo: roda em CÓDIGO = 0 tokens de IA. Só acrescenta ~40–50 tokens por empresa")
        print("    SE você carregar os resultados no contexto de uma IA (desprezível se ficar no disco).")
        enrich_socials(results)
        fields = fields + [k for k in SOCIALS if k not in fields]
        found = sum(1 for r in results if any(r.get(k) for k in SOCIALS))
        print(f"  redes sociais encontradas para {found}/{len(results)} empresas")

    # Saída padrão é um CSV (abre no Excel / Google Sheets). Use --json (ou --out .json) para JSON.
    # O CSV sai em UTF-8 com BOM para o Excel em português mostrar acentos corretamente.
    as_json = a.json or (a.out and a.out.lower().endswith(".json"))
    out = a.out or f"results-{job_id[:8]}.{'json' if as_json else 'csv'}"
    if as_json:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
    else:
        with open(out, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(results)
    print(f"  salvo → {out}")
    for r in results[:5]:
        if a.socials:
            tail = f" | IG:{r.get('instagram', '') or '—'} | WA:{r.get('whatsapp', '') or '—'}"
        else:
            tail = f" | {r.get('website', '')}"
        print(f"  • {r.get('title', '')} | {r.get('phone', '')} | {r.get('emails', '')}{tail}")


if __name__ == "__main__":
    main()
