#!/usr/bin/env python3
"""Interface com mapa do leadsNEGOCIOS: desenhe uma área, diga o tipo de negócio e receba o CSV de leads.

    py scripts\\app.py            (Windows)
    python3 scripts/app.py        (macOS / Linux)

Abre http://localhost:8090 no navegador. Só biblioteca padrão; usa o motor local (docker compose up -d)
e as mesmas funções do scripts/scrape.py (blocos, sem duplicatas, e-mails, WhatsApp e redes sociais).
A página fica presa ao 127.0.0.1, como o motor.
"""
import argparse, csv, json, math, os, re, sys, threading, time, unicodedata, uuid, webbrowser
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scrape  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, os.pardir))
WEB = os.path.join(ROOT, "web")
OUT_DIR = os.path.join(ROOT, "resultados")
MAX_GRID = 8          # 8 x 8 = 64 jobs é o teto
MAX_KEYWORDS = 20
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml"}


def auto_grid(bbox):
    """Sugestão de N x N pelo maior lado da área, em km (a página usa a mesma regra)."""
    s, n, w, e = (float(x) for x in bbox)
    h = (n - s) * 111.2
    wd = (e - w) * 111.2 * math.cos(math.radians((n + s) / 2))
    side = max(h, wd)
    for limit, size in ((4, 1), (10, 2), (20, 3), (35, 4)):
        if side <= limit:
            return size
    return 5


def slug(text):
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:40] or "leads"


class Run:
    """Estado de uma busca em andamento, lido pela página a cada poucos segundos."""

    def __init__(self, params):
        self.id = uuid.uuid4().hex[:8]
        self.params = params
        self.state = "running"        # running | done | error | cancelled
        self.stage = "Preparando…"
        self.block, self.blocks = 0, 0
        self.found = 0
        self.log = []
        self.points = []              # [{lat, lon, title}] para o mapa durante a busca
        self.results = []
        self.fields = []
        self.file = None
        self.summary = {}
        self.cancel = False
        self.lock = threading.Lock()
        # Sinais de vida para a página: relógio do bloco, última resposta do motor, parciais.
        self.started = time.time()
        self.block_started = None
        self.job_id = None
        self.job_status = None        # status do job atual no motor (pending / working / ok)
        self.last_check = None        # quando o motor respondeu pela última vez
        self.engine_ok = True
        self.block_found = 0          # resultados do bloco atual já gravados pelo motor
        self.last_progress = time.time()
        self.block_secs = []          # duração dos blocos já concluídos, para a previsão

    def say(self, msg):
        with self.lock:
            self.log.append(f"{time.strftime('%H:%M:%S')} {msg}")
            del self.log[:-200]
        print(msg, flush=True)

    def snapshot(self):
        with self.lock:
            return {"id": self.id, "state": self.state, "stage": self.stage, "block": self.block,
                    "blocks": self.blocks, "found": self.found, "log": self.log[-40:],
                    "points": self.points, "fields": self.fields, "results": self.results[:300],
                    "total": len(self.results), "file": os.path.basename(self.file) if self.file else None,
                    "summary": self.summary, "now": time.time(), "started": self.started,
                    "block_started": self.block_started, "job_id": self.job_id,
                    "job_status": self.job_status, "last_check": self.last_check,
                    "engine_ok": self.engine_ok, "block_found": self.block_found,
                    "last_progress": self.last_progress, "keywords": len(self.params["keywords"]),
                    "depth": self.params["depth"], "email": self.params["email"],
                    "avg_block": sum(self.block_secs) / len(self.block_secs) if self.block_secs else None}


CURRENT = {"run": None}
RUNS = {}


def wait_job(run, job_id, max_time, on_partial=None):
    """Acompanha um job do motor -> "ok", "cancelled" ou "timeout". Levanta RuntimeError se o job falhar
    ou o motor parar de responder. A cada ~10 s baixa o CSV parcial (o motor grava linha a linha)
    e entrega a on_partial, para a página mostrar o que já foi encontrado."""
    deadline = time.time() + max_time + 180
    fails, next_peek = 0, time.time() + 5
    while time.time() < deadline:
        if run.cancel:
            return "cancelled"
        try:
            _, raw = scrape.req("GET", f"/api/v1/jobs/{job_id}")
            status = json.loads(raw).get("Status")
            fails = 0
            with run.lock:
                run.job_status, run.last_check, run.engine_ok = status, time.time(), True
        except Exception as e:
            fails += 1
            with run.lock:
                run.engine_ok = False
            if fails >= 24:  # ~2 min sem resposta
                raise RuntimeError(f"o motor parou de responder ({e}). Confira o Docker Desktop.")
            time.sleep(5)
            continue
        if status == "ok":
            return "ok"
        if status == "failed":
            raise RuntimeError("o job falhou (se repetir, o IP pode estar limitado: espere ou use proxies)")
        if on_partial and time.time() >= next_peek:
            next_peek = time.time() + 10
            try:
                on_partial(scrape.download_job(job_id))
            except Exception:
                pass  # o CSV parcial ainda não existe no começo do job
        time.sleep(5)
    return "timeout"


def point(r):
    """Linha -> marcador do mapa com os dados do pop-up, ou None sem coordenadas."""
    try:
        p = {"lat": float(r["latitude"]), "lon": float(r["longitude"])}
    except (KeyError, TypeError, ValueError):
        return None
    for k in ("title", "category", "phone", "whatsapp", "emails", "website"):
        if r.get(k):
            p[k] = r[k]
    return p


def execute(run):
    p = run.params
    try:
        bbox = p["bbox"]
        cells = scrape.grid_cells(bbox, p["grid"])
        run.blocks = len(cells)
        run.say(f"Área dividida em {len(cells)} bloco(s); termos: {', '.join(p['keywords'])}")
        body = {"name": f"mapa-{slug(p['keywords'][0])}", "keywords": p["keywords"], "lang": p["lang"],
                "fast_mode": False, "depth": p["depth"], "email": p["email"], "max_time": p["max_time"]}
        rows, ok_blocks = [], 0
        for i, cell in enumerate(cells, 1):  # um de cada vez de propósito: nunca jobs paralelos contra o Google
            if run.cancel:
                run.say("Cancelado: os blocos restantes não serão buscados.")
                break
            with run.lock:
                run.block, run.block_started, run.block_found = i, time.time(), 0
                run.job_id, run.job_status, run.last_progress = None, None, time.time()
                run.stage = f"Buscando no Google Maps: bloco {i} de {len(cells)}"

            def merge(cell_rows, base=rows):
                merged = scrape.dedupe(base + cell_rows)
                if p["clip"]:
                    merged = [r for r in merged if scrape.in_bbox(r, bbox, margin=0.02)]
                return merged

            def on_partial(part, merge=merge):
                merged = merge(part)
                with run.lock:
                    if len(part) > run.block_found:
                        run.last_progress = time.time()
                    run.block_found, run.found = len(part), len(merged)
                    run.points = [x for x in map(point, merged) if x]

            try:
                _, raw = scrape.req("POST", "/api/v1/jobs", dict(body, **cell))
                job_id = json.loads(raw).get("id")
                if not job_id:
                    raise RuntimeError("o motor não devolveu o id do job")
                run.job_id = job_id
                run.say(f"Bloco {i}/{len(cells)}: job {job_id}")
                outcome = wait_job(run, job_id, p["max_time"], on_partial)
                try:
                    cell_rows = scrape.download_job(job_id)  # parcial se cancelado ou no tempo-limite
                except Exception:
                    if outcome == "ok":
                        raise
                    cell_rows = []
            except Exception as e:
                run.say(f"⚠ Bloco {i}/{len(cells)} ignorado: {e}")
                continue
            if outcome == "ok":
                run.block_secs.append(time.time() - run.block_started)
            elif outcome == "cancelled":
                run.say(f"Cancelado no bloco {i}: guardando os {len(cell_rows)} resultados que já tinham saído. "
                        "O motor termina este job sozinho, sem novos blocos.")
            else:
                run.say(f"⚠ Bloco {i}/{len(cells)} passou do tempo-limite: guardando os {len(cell_rows)} resultados parciais.")
            ok_blocks += 1 if cell_rows or outcome == "ok" else 0
            rows = merge(cell_rows)
            with run.lock:
                run.found, run.block_found = len(rows), len(cell_rows)
                run.points = [x for x in map(point, rows) if x]
            run.say(f"Bloco {i}/{len(cells)}: {len(cell_rows)} resultados, {len(rows)} únicos na área até agora")
        if not ok_blocks and run.cancel:
            raise RuntimeError("busca cancelada antes de sair qualquer resultado.")
        if not ok_blocks:
            raise RuntimeError("nenhum bloco deu certo. Confira se o motor está no ar "
                               "(docker compose up -d) ou espere alguns minutos se o IP estiver limitado.")

        fields = list(scrape.LEAD)
        results = [{k: r.get(k, "") for k in fields} for r in rows]
        if p["email"]:
            run.stage = "Procurando e-mails nas páginas de contato dos sites…"
            before = sum(1 for r in results if r.get("emails"))
            scrape.enrich_emails(results)
            after = sum(1 for r in results if r.get("emails"))
            run.say(f"E-mails: {before} do motor, +{after - before} das páginas de contato")
        if p["socials"]:
            run.stage = "Procurando WhatsApp, Instagram, Facebook e LinkedIn nos sites…"
            scrape.enrich_socials(results)
            fields += scrape.SOCIALS
        for r, raw_row in zip(results, rows):  # coordenadas só para o mapa e o CSV, no fim da linha
            r["latitude"], r["longitude"] = raw_row.get("latitude", ""), raw_row.get("longitude", "")
        fields += ["latitude", "longitude"]

        os.makedirs(OUT_DIR, exist_ok=True)
        path = os.path.join(OUT_DIR, f"{slug(p['keywords'][0])}-{time.strftime('%Y%m%d-%H%M%S')}.csv")
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(results)
        n = len(results)
        summary = {"total": n,
                   "emails": sum(1 for r in results if r.get("emails")),
                   "telefones": sum(1 for r in results if r.get("phone")),
                   "sites": sum(1 for r in results if r.get("website"))}
        if p["socials"]:
            summary["whatsapp"] = sum(1 for r in results if r.get("whatsapp"))
            summary["instagram"] = sum(1 for r in results if r.get("instagram"))
        with run.lock:
            run.results, run.fields, run.file, run.summary = results, fields, path, summary
            run.points = [x for x in map(point, results) if x]
            run.state = "cancelled" if run.cancel else "done"
            run.stage = f"Pronto: {n} empresas salvas em resultados/{os.path.basename(path)}"
        run.say(run.stage)
    except Exception as e:
        with run.lock:
            run.state, run.stage = "error", f"Erro: {e}"
        run.say(run.stage)


def parse_params(data):
    """Valida o pedido da página -> dict de parâmetros, ou levanta ValueError com a mensagem."""
    kws = [k.strip() for k in str(data.get("keywords", "")).splitlines() if k.strip()]
    kws = list(dict.fromkeys(kws))
    if not kws:
        raise ValueError("Digite pelo menos um tipo de negócio (ex.: padarias).")
    if len(kws) > MAX_KEYWORDS:
        raise ValueError(f"No máximo {MAX_KEYWORDS} termos por busca.")
    try:
        s, n, w, e = (float(x) for x in data["bbox"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("Desenhe a área no mapa antes de buscar.")
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        raise ValueError("Área inválida. Desenhe o retângulo de novo.")
    bbox = [s, n, w, e]
    grid = data.get("grid") or "auto"
    grid = auto_grid(bbox) if grid == "auto" else int(grid)
    if not 1 <= grid <= MAX_GRID:
        raise ValueError(f"A divisão deve ficar entre 1x1 e {MAX_GRID}x{MAX_GRID}.")
    depth = int(data.get("depth") or 5)
    lang = str(data.get("lang") or "pt")
    if not re.fullmatch(r"[a-z]{2}", lang):
        raise ValueError("Idioma deve ter 2 letras (ex.: pt).")
    return {"keywords": kws, "bbox": bbox, "grid": grid, "depth": max(1, min(depth, 30)), "lang": lang,
            "email": bool(data.get("email", True)), "socials": bool(data.get("socials", True)),
            "clip": bool(data.get("clip", True)), "max_time": 600 if depth <= 10 else 900}


class Handler(BaseHTTPRequestHandler):
    server_version = "leadsNEGOCIOS"

    def log_message(self, *a):
        pass

    def _host_ok(self):
        # Bloqueia DNS rebinding: só aceita a página aberta como localhost / 127.0.0.1.
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in ("localhost", "127.0.0.1")

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, "host não permitido", "text/plain; charset=utf-8")
        url = urllib.parse.urlparse(self.path)
        path, q = url.path, urllib.parse.parse_qs(url.query)
        if path == "/":
            path = "/index.html"
        if path == "/api/health":
            try:
                scrape.req("GET", "/api/v1/jobs")
                return self._json(200, {"engine": True, "base": scrape.BASE})
            except Exception as e:
                return self._json(200, {"engine": False, "base": scrape.BASE, "error": str(e)})
        if path == "/api/geocode":
            place = (q.get("q") or [""])[0].strip()
            geo = scrape.geocode(place, with_bbox=True) if place else None
            if not geo or not geo[2]:
                return self._json(404, {"error": f"Não achei \"{place}\". Tente \"Cidade, UF\"."})
            return self._json(200, {"lat": float(geo[0]), "lon": float(geo[1]),
                                    "bbox": [float(x) for x in geo[2]]})
        if path == "/api/status":
            run = RUNS.get((q.get("id") or [""])[0]) or CURRENT["run"]
            return self._json(200, run.snapshot() if run else {"state": "idle"})
        if path == "/api/download":
            run = RUNS.get((q.get("id") or [""])[0])
            if not run or not run.file or not os.path.exists(run.file):
                return self._json(404, {"error": "Arquivo não encontrado."})
            with open(run.file, "rb") as f:
                data = f.read()
            name = os.path.basename(run.file)
            return self._send(200, data, "text/csv; charset=utf-8",
                              {"Content-Disposition": f'attachment; filename="{name}"'})
        # Arquivos estáticos da pasta web/
        full = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
        if not full.startswith(WEB + os.sep) or not os.path.isfile(full):
            return self._send(404, "não encontrado", "text/plain; charset=utf-8")
        with open(full, "rb") as f:
            self._send(200, f.read(), TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))

    def do_POST(self):
        # Content-Type JSON obriga o navegador a um preflight CORS em pedidos de outros sites,
        # que este servidor não responde: só a própria página consegue iniciar uma busca.
        if not self._host_ok() or not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self._json(403, {"error": "pedido não permitido"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(min(length, 100_000)) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "JSON inválido"})
        if self.path == "/api/search":
            cur = CURRENT["run"]
            if cur and cur.state == "running":
                return self._json(409, {"error": "Já existe uma busca em andamento. Espere ou cancele."})
            try:
                params = parse_params(data)
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            run = Run(params)
            RUNS[run.id] = CURRENT["run"] = run
            threading.Thread(target=execute, args=(run,), daemon=True).start()
            return self._json(200, {"id": run.id, "blocks": params["grid"] ** 2})
        if self.path == "/api/cancel":
            run = CURRENT["run"]
            if run and run.state == "running":
                run.cancel = True
                run.say("Cancelamento pedido: termina o bloco atual e salva o que já foi encontrado.")
            return self._json(200, {"ok": True})
        self._json(404, {"error": "não encontrado"})


def main():
    ap = argparse.ArgumentParser(description="Interface com mapa do leadsNEGOCIOS.")
    ap.add_argument("--port", type=int, default=int(os.environ.get("APP_PORT") or 8090))
    ap.add_argument("--no-browser", action="store_true", help="não abre o navegador automaticamente")
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://localhost:{a.port}"
    print(f"✓ leadsNEGOCIOS no ar: {url}  (motor: {scrape.BASE})")
    print("  Deixe esta janela aberta enquanto usa a página. Ctrl+C para sair.")
    if not a.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nAté mais!")


if __name__ == "__main__":
    main()
