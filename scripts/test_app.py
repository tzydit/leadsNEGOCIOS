#!/usr/bin/env python3
"""Testes offline de scripts/app.py (interface com mapa). Rodar: python3 scripts/test_app.py"""
import csv, io, json, os, sys, tempfile, threading, time, unittest, urllib.request, urllib.error
from contextlib import redirect_stdout
from http.server import ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app, scrape  # noqa: E402
from test_scrape import MockEngine  # noqa: E402

CURITIBA = [-25.65, -25.34, -49.39, -49.18]  # ~21 x 34 km


class Params(unittest.TestCase):
    def test_auto_grid(self):
        self.assertEqual(app.auto_grid([-25.44, -25.43, -49.28, -49.27]), 1)   # ~1 km
        self.assertEqual(app.auto_grid([-25.50, -25.43, -49.30, -49.25]), 2)   # ~8 km
        self.assertEqual(app.auto_grid(CURITIBA), 4)
        self.assertEqual(app.auto_grid([-24.0, -23.3, -47.0, -46.3]), 5)       # ~78 km

    def test_parse_ok(self):
        p = app.parse_params({"keywords": " padarias \n\nconfeitarias\npadarias", "bbox": CURITIBA,
                              "grid": "auto", "depth": "5"})
        self.assertEqual(p["keywords"], ["padarias", "confeitarias"])
        self.assertEqual((p["grid"], p["depth"], p["lang"], p["max_time"]), (4, 5, "pt", 600))
        self.assertTrue(p["email"] and p["socials"] and p["clip"])

    def test_parse_errors(self):
        bad = [({"keywords": "", "bbox": CURITIBA}, "tipo de negócio"),
               ({"keywords": "x"}, "Desenhe a área"),
               ({"keywords": "x", "bbox": [1, 0, 0, 1]}, "Área inválida"),
               ({"keywords": "x", "bbox": CURITIBA, "grid": "9"}, "entre 1x1"),
               ({"keywords": "x", "bbox": CURITIBA, "lang": "pt-BR"}, "2 letras"),
               ({"keywords": "\n".join(f"k{i}" for i in range(25)), "bbox": CURITIBA}, "No máximo")]
        for data, msg in bad:
            with self.assertRaises(ValueError) as cm:
                app.parse_params(data)
            self.assertIn(msg, str(cm.exception))

    def test_slug(self):
        self.assertEqual(app.slug("Pães & Cafés em São Paulo"), "paes-cafes-em-sao-paulo")
        self.assertEqual(app.slug("!!!"), "leads")


class WaitJob(unittest.TestCase):
    def setUp(self):
        self.run = app.Run(app.parse_params({"keywords": "x", "bbox": CURITIBA}))
        self.clock = [1000.0]
        self.patches = [mock.patch.object(app.time, "time", lambda: self.clock[0]),
                        mock.patch.object(app.time, "sleep", lambda s: self.clock.__setitem__(0, self.clock[0] + s))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_partials_then_ok(self):
        statuses = iter(["pending"] + ["working"] * 5 + ["ok"])
        seen = []
        with mock.patch.object(scrape, "req", lambda m, path, body=None: (200, json.dumps({"Status": next(statuses)}).encode())), \
             mock.patch.object(scrape, "download_job", lambda jid: [{"title": "a"}] * (len(seen) + 1)):
            self.assertEqual(app.wait_job(self.run, "j1", 600, seen.append), "ok")
        self.assertGreaterEqual(len(seen), 2)               # baixou parciais enquanto trabalhava
        self.assertEqual(self.run.job_status, "ok")
        self.assertTrue(self.run.engine_ok)

    def test_cancel(self):
        self.run.cancel = True
        self.assertEqual(app.wait_job(self.run, "j1", 600), "cancelled")

    def test_engine_down(self):
        def boom(*a, **k):
            raise OSError("connection refused")
        with mock.patch.object(scrape, "req", boom):
            with self.assertRaises(RuntimeError) as cm:
                app.wait_job(self.run, "j1", 600)
        self.assertIn("parou de responder", str(cm.exception))
        self.assertFalse(self.run.engine_ok)

    def test_failed_and_timeout(self):
        with mock.patch.object(scrape, "req", lambda *a, **k: (200, b'{"Status":"failed"}')):
            with self.assertRaises(RuntimeError):
                app.wait_job(self.run, "j1", 600)
        with mock.patch.object(scrape, "req", lambda *a, **k: (200, b'{"Status":"working"}')), \
             mock.patch.object(scrape, "download_job", lambda jid: []):
            self.assertEqual(app.wait_job(self.run, "j1", 60), "timeout")

    def test_snapshot_has_live_fields(self):
        snap = self.run.snapshot()
        for k in ("now", "started", "block_started", "job_status", "last_check", "engine_ok",
                  "block_found", "last_progress", "avg_block", "keywords"):
            self.assertIn(k, snap)


class Server(unittest.TestCase):
    def setUp(self):
        self.engine = ThreadingHTTPServer(("127.0.0.1", 0), MockEngine)
        threading.Thread(target=self.engine.serve_forever, daemon=True).start()
        self.app = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        threading.Thread(target=self.app.serve_forever, daemon=True).start()
        self.base = f"http://localhost:{self.app.server_port}"
        self.out = tempfile.mkdtemp()
        self.patches = [mock.patch.object(scrape, "BASE", f"http://127.0.0.1:{self.engine.server_port}"),
                        mock.patch.object(app, "OUT_DIR", self.out)]
        for p in self.patches:
            p.start()
        app.CURRENT["run"] = None

    def tearDown(self):
        for p in self.patches:
            p.stop()
        for s in (self.engine, self.app):
            s.shutdown(); s.server_close()

    def call(self, path, body=None, headers=None):
        h = {"Content-Type": "application/json"} if body is not None else {}
        h.update(headers or {})
        r = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                                   headers=h, method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_page_and_health(self):
        code, html = self.call("/")
        self.assertEqual(code, 200)
        self.assertIn(b"leaflet.js", html)
        self.assertEqual(self.call("/vendor/leaflet/leaflet.js")[0], 200)
        self.assertEqual(self.call("/../scripts/app.py")[0], 404)
        self.assertTrue(json.loads(self.call("/api/health")[1])["engine"])

    def test_rejects_foreign_host_and_form_posts(self):
        self.assertEqual(self.call("/", headers={"Host": "evil.example:80"})[0], 403)
        r = urllib.request.Request(self.base + "/api/search", data=b"keywords=x", method="POST",
                                   headers={"Content-Type": "application/x-www-form-urlencoded"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(r, timeout=10)
        self.assertEqual(cm.exception.code, 403)

    def test_search_flow(self):
        # Área ao redor das linhas do motor simulado (lat 30.2, lon -97.7); job-3 falha e é ignorado.
        MockEngine.created = 0
        with redirect_stdout(io.StringIO()):
            code, raw = self.call("/api/search", {"keywords": "encanadores", "bbox": [30.0, 30.5, -98.0, -97.5],
                                                  "grid": "2", "email": False, "socials": False})
            self.assertEqual(code, 200, raw)
            run_id = json.loads(raw)["id"]
            self.assertEqual(self.call("/api/search", {"keywords": "x", "bbox": [30.0, 30.5, -98.0, -97.5]})[0], 409)
            with mock.patch.object(app.time, "sleep"):
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:  # time.sleep está simulado: este laço não dorme
                    st = json.loads(self.call(f"/api/status?id={run_id}")[1])
                    if st["state"] != "running":
                        break
        self.assertEqual(st["state"], "done", st)
        self.assertEqual([r["title"] for r in st["results"]], ["Empresa A", "Empresa B", "Empresa C", "Empresa D", "Empresa E"])
        self.assertEqual(len(st["points"]), 5)      # F (fora da área) foi descartada
        self.assertTrue(any("Bloco 3/4 ignorado" in l for l in st["log"]))
        code, data = self.call(f"/api/download?id={run_id}")
        self.assertEqual(code, 200)
        rows = list(csv.DictReader(io.StringIO(data.decode("utf-8-sig"))))
        self.assertEqual(rows[0]["title"], "Empresa A")
        self.assertEqual(list(rows[0])[-2:], ["latitude", "longitude"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
