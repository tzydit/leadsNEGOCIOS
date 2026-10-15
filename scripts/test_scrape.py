#!/usr/bin/env python3
"""Testes offline de scripts/scrape.py (só biblioteca padrão, sem rede).
Rodar: python3 scripts/test_scrape.py"""
import csv, importlib.util, io, json, os, sys, tempfile, threading, unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

_spec = importlib.util.spec_from_file_location(
    "scrape", os.path.join(os.path.dirname(os.path.abspath(__file__)), "scrape.py"))
scrape = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scrape)

BBOX = ["30.0", "30.5", "-98.0", "-97.5"]  # ordem do Nominatim: sul, norte, oeste, leste


class GridCells(unittest.TestCase):
    def test_count_centers_radius(self):
        cells = scrape.grid_cells(BBOX, 3)
        self.assertEqual(len(cells), 9)
        for c in cells:
            self.assertTrue(30.0 < float(c["lat"]) < 30.5)
            self.assertTrue(-98.0 < float(c["lon"]) < -97.5)
            self.assertGreaterEqual(c["radius"], 1000)
            self.assertEqual(len(c["lat"].split(".")[1]), 6)
            self.assertEqual(c["zoom"], 13)  # blocos de ~16 km: visão de bairro, não de quarteirão

    def test_zoom_follows_tile_size(self):
        self.assertEqual(scrape.grid_cells(BBOX, 1)[0]["zoom"], 11)                # ~48 km: limitado
        self.assertEqual(scrape.grid_cells(["0", "0.001", "0", "0.001"], 1)[0]["zoom"], 17)  # 110 m: limitado

    def test_one_cell_is_bbox_center(self):
        (c,) = scrape.grid_cells(BBOX, 1)
        self.assertEqual((c["lat"], c["lon"]), ("30.250000", "-97.750000"))
        self.assertGreater(c["radius"], 30000)  # caixa de ~0,5 x 0,5 grau

    def test_tiny_box_floors_at_1000(self):
        self.assertEqual(scrape.grid_cells(["0", "0.001", "0", "0.001"], 2)[0]["radius"], 1000)

    def test_southern_hemisphere(self):
        sp = ["-24.0", "-23.3", "-46.9", "-46.3"]  # retângulo aproximado de São Paulo
        cells = scrape.grid_cells(sp, 2)
        self.assertEqual(len(cells), 4)
        self.assertTrue(all(-24.0 < float(c["lat"]) < -23.3 for c in cells))


class Dedupe(unittest.TestCase):
    def test_key_order(self):
        rows = [
            {"place_id": "P1", "cid": "C1", "title": "a"},
            {"place_id": "P1", "cid": "C9", "title": "dup place_id"},
            {"cid": "C2", "link": "L1"},
            {"cid": "C2", "link": "L9", "title": "dup cid"},
            {"link": "L3"},
            {"link": "L3", "title": "dup link"},
            {"title": "Padaria do Zé", "address": "Rua A, 1"},
            {"title": "Padaria do Zé", "address": "Rua A, 1", "phone": "dup title+address"},
            {"title": "Padaria do Zé", "address": "Rua B, 2"},
        ]
        out = scrape.dedupe(rows)
        self.assertEqual(len(out), 5)
        self.assertEqual(out[0]["title"], "a")  # a primeira ocorrência vence
        self.assertNotIn("dup", json.dumps(out))


class InBbox(unittest.TestCase):
    def test_margin_and_missing(self):
        self.assertTrue(scrape.in_bbox({"latitude": "30.2", "longitude": "-97.7"}, BBOX))
        self.assertTrue(scrape.in_bbox({"latitude": "30.54", "longitude": "-97.7"}, BBOX))   # dentro de 10%
        self.assertFalse(scrape.in_bbox({"latitude": "30.56", "longitude": "-97.7"}, BBOX))  # além de 10%
        self.assertFalse(scrape.in_bbox({"latitude": "30.2", "longitude": "-98.1"}, BBOX))
        self.assertTrue(scrape.in_bbox({"latitude": "", "longitude": ""}, BBOX))
        self.assertTrue(scrape.in_bbox({"latitude": "n/a"}, BBOX))
        self.assertTrue(scrape.in_bbox({}, BBOX))


class ExtractEmails(unittest.TestCase):
    def test_mailto_regex_junk_preference_cap(self):
        html = """
          <a href="mailto:Dono@Gmail.com?subject=Oi">Mail</a>
          <a href="mailto:CONTATO@acmeencanamentos.com.br">contato</a>
          Escreva para vendas@acmeencanamentos.com.br ou contato@acmeencanamentos.com.br.
          <img src="logo@2x.png"> hello@example.com x@sentry.io a@b.wixpress.com
          nome@empresa.com.br seuemail@gmail.com joao@seudominio.com.br
        """
        out = scrape.extract_emails(html, "www.acmeencanamentos.com.br")
        self.assertEqual(out, ["contato@acmeencanamentos.com.br", "vendas@acmeencanamentos.com.br",
                               "dono@gmail.com"])

    def test_empty(self):
        self.assertEqual(scrape.extract_emails("", "x.com"), [])
        self.assertEqual(scrape.extract_emails("nenhum e-mail aqui", "x.com"), [])


class ContactLinks(unittest.TestCase):
    def test_discovers_same_site_only(self):
        html = """<a href="/fale-conosco#form">Fale conosco</a>
                  <a href="https://www.acme.com.br/equipe">Quem somos</a>
                  <a href="https://facebook.com/acme/about">FB</a>
                  <a href="mailto:a@acme.com.br">contato</a>
                  <a href="/servicos">Serviços</a>"""
        out = scrape.contact_links(html, "https://acme.com.br")
        self.assertEqual(out[:2], ["https://acme.com.br/fale-conosco", "https://www.acme.com.br/equipe"])
        self.assertEqual(len(out), 3)
        self.assertEqual(out[2], "https://acme.com.br/contato")  # primeiro caminho fixo
        self.assertFalse(any("facebook" in u or "mailto" in u for u in out))

    def test_fallbacks_and_max(self):
        self.assertEqual(scrape.contact_links("", "acme.com.br"),
                         ["http://acme.com.br/contato", "http://acme.com.br/fale-conosco",
                          "http://acme.com.br/contact"])
        many = "".join(f'<a href="/contato{i}">x</a>' for i in range(6))
        self.assertEqual(len(scrape.contact_links(many, "http://acme.com.br")), 3)


class Socials(unittest.TestCase):
    def test_platforms_and_skips(self):
        html = """<a href="https://www.instagram.com/p/abc">post</a>
                  <a href="https://instagram.com/padariadoze/">IG</a>
                  <a href="https://facebook.com/sharer.php?u=x">share</a>
                  <a href="https://www.facebook.com/2008">junk</a>
                  <a href="https://pt-br.facebook.com/padariadoze">FB</a>
                  <a href="https://www.linkedin.com/company/padaria-do-ze">LI</a>"""
        out = scrape._find_socials(html)
        self.assertEqual(out["instagram"], "https://instagram.com/padariadoze")
        self.assertEqual(out["facebook"], "https://pt-br.facebook.com/padariadoze")
        self.assertEqual(out["linkedin"], "https://www.linkedin.com/company/padaria-do-ze")
        self.assertEqual(out["whatsapp"], "")

    def test_whatsapp_formats(self):
        cases = {
            '<a href="https://wa.me/5511987654321">WhatsApp</a>': "https://wa.me/5511987654321",
            '<a href="https://wa.me/+55 (41) 99876-5432">zap</a>': "https://wa.me/5541998765432",
            '<a href="https://api.whatsapp.com/send?phone=5521912345678&text=Oi">': "https://wa.me/5521912345678",
            '<a href="https://api.whatsapp.com/send/?text=Oi&amp;phone=5531988887777">': "https://wa.me/5531988887777",
            '<a href="whatsapp://send?phone=5548999990000">': "https://wa.me/5548999990000",
            '<a href="https://web.whatsapp.com/send?phone=5585977776666">': "https://wa.me/5585977776666",
        }
        for html, want in cases.items():
            self.assertEqual(scrape._find_whatsapp(html), want, html)

    def test_website_is_social_profile(self):
        rows = [{"website": "https://instagram.com/panpanpaes?utm_medium=copy_link"},
                {"website": "http://www.instagram.com/panificadoramihra"},
                {"website": "https://wa.me/5541999998888"},
                {"website": ""}]
        page = '<a href="https://www.instagram.com/outra_conta">x</a><a href="https://facebook.com/padaria">fb</a>'
        with mock.patch.object(scrape, "_fetch_cached", return_value=page), redirect_stdout(io.StringIO()):
            scrape.enrich_socials(rows)
        self.assertEqual(rows[0]["instagram"], "https://instagram.com/panpanpaes")
        self.assertEqual(rows[0]["facebook"], "https://facebook.com/padaria")  # ainda lê a página
        self.assertEqual(rows[1]["instagram"], "http://www.instagram.com/panificadoramihra")
        self.assertEqual(rows[2]["whatsapp"], "https://wa.me/5541999998888")
        self.assertEqual(rows[3], {"website": "", "instagram": "", "facebook": "", "linkedin": "", "whatsapp": ""})

    def test_whatsapp_rejects_short_numbers(self):
        self.assertEqual(scrape._find_whatsapp('<a href="https://wa.me/123">x</a>'), "")
        self.assertEqual(scrape._find_whatsapp(""), "")
        self.assertEqual(scrape._find_whatsapp(None), "")


# ── Ponta a ponta contra um motor simulado ──
FIELDS = ["input_id", "link", "title", "category", "address", "website", "phone", "review_count",
          "review_rating", "latitude", "longitude", "cid", "place_id", "emails"]

def _row(pid, lat="30.2"):
    return {"title": f"Empresa {pid}", "place_id": pid, "cid": "c" + pid, "latitude": lat,
            "longitude": "-97.7", "phone": "+55 11", "emails": f"{pid.lower()}@empresa.com.br"}

CELL_ROWS = {"job-1": [_row("A"), _row("B"), _row("C")],
             "job-2": [_row("C"), _row("D")],
             "job-3": None,  # este bloco falha
             "job-4": [_row("A"), _row("E"), _row("F", lat="40.0")]}  # F está fora da cidade


class MockEngine(BaseHTTPRequestHandler):
    created, polls, bodies = 0, {}, []

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        MockEngine.bodies.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        MockEngine.created += 1
        self._send(201, json.dumps({"id": f"job-{MockEngine.created}"}))

    def do_GET(self):
        parts = self.path.strip("/").split("/")  # api v1 jobs [id [download]]
        if len(parts) == 3:
            return self._send(200, "[]")
        jid = parts[3]
        if len(parts) == 5:
            buf = io.StringIO()
            w = csv.DictWriter(buf, fieldnames=FIELDS, restval="")
            w.writeheader(); w.writerows(CELL_ROWS[jid])
            return self._send(200, buf.getvalue(), "text/csv")
        n = MockEngine.polls[jid] = MockEngine.polls.get(jid, 0) + 1
        status = "failed" if CELL_ROWS[jid] is None else ("ok" if n >= 2 else "working")
        self._send(200, json.dumps({"Status": status}))


class EndToEnd(unittest.TestCase):
    def test_grid_run(self):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), MockEngine)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        out = os.path.join(tempfile.mkdtemp(), "leads.csv")
        argv = ["scrape.py", "encanadores em Campinas SP", "--city", "Campinas, SP",
                "--grid", "2", "--no-deep-emails", "--out", out]
        log = io.StringIO()
        try:
            with mock.patch.object(scrape, "BASE", f"http://127.0.0.1:{srv.server_port}"), \
                 mock.patch.object(scrape, "geocode", return_value=("30.25", "-97.75", BBOX)), \
                 mock.patch.object(scrape.time, "sleep"), \
                 mock.patch.object(sys, "argv", argv), redirect_stdout(log):
                scrape.main()
        finally:
            srv.shutdown(); srv.server_close()
        text = log.getvalue()
        self.assertIn("bloco 4/4: 3 linhas, 6 únicas até agora", text)
        self.assertIn("bloco 3/4 ignorado", text)
        self.assertIn("descartadas 1 linhas fora do retângulo da cidade", text)
        self.assertTrue(all(b["lang"] == "pt" for b in MockEngine.bodies))
        with open(out, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[0], scrape.LEAD)
        self.assertEqual([r[0] for r in rows[1:]],
                         ["Empresa A", "Empresa B", "Empresa C", "Empresa D", "Empresa E"])

    def test_existing_job(self):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), MockEngine)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        out = os.path.join(tempfile.mkdtemp(), "leads.csv")
        created = MockEngine.created
        argv = ["scrape.py", "--job", "job-2", "--no-deep-emails", "--out", out]
        try:
            with mock.patch.object(scrape, "BASE", f"http://127.0.0.1:{srv.server_port}"), \
                 mock.patch.object(scrape, "geocode") as geo, \
                 mock.patch.object(sys, "argv", argv), redirect_stdout(io.StringIO()):
                scrape.main()
        finally:
            srv.shutdown(); srv.server_close()
        self.assertEqual(MockEngine.created, created)  # nenhuma busca nova
        geo.assert_not_called()
        with open(out, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        self.assertEqual([r["title"] for r in rows], ["Empresa C", "Empresa D"])
        self.assertEqual(rows[0]["emails"], "c@empresa.com.br")

    def test_existing_job_not_found(self):
        argv = ["scrape.py", "--job", "nao-existe"]
        with mock.patch.object(scrape, "BASE", "http://127.0.0.1:9"), \
             mock.patch.object(sys, "argv", argv), redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                scrape.main()
        self.assertIn("Não foi possível baixar o job nao-existe", str(cm.exception.code))


if __name__ == "__main__":
    unittest.main(verbosity=2)
