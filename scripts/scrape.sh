#!/usr/bin/env bash
# Busca no Google Maps para um termo: cria o job, acompanha, baixa e salva os 8 campos de lead em CSV.
# Uso:     ./scripts/scrape.sh "<termo>" <lat> <lon> [depth]
# Exemplo: ./scripts/scrape.sh "cafeterias em São Paulo SP" -23.5505 -46.6333 5
# Baseado no Google Maps Scraper Kit (MIT, (c) 2026 Mahan). Veja CREDITS.md.
set -euo pipefail

# Lê SCRAPER_* do .env do projeto, o mesmo arquivo que o docker compose lê, para que trocar a
# porta exija uma única edição. Variáveis já exportadas no shell têm prioridade sobre o arquivo.
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r k v || [ -n "$k" ]; do
    case "$k" in SCRAPER_BASE_URL|SCRAPER_PORT|SCRAPER_API_KEY) ;; *) continue ;; esac
    v="${v%$'\r'}"; v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
    [ -n "${!k+x}" ] || export "$k=$v"
  done < "$ENV_FILE"
fi

BASE="${SCRAPER_BASE_URL:-http://localhost:${SCRAPER_PORT:-8080}}"
KEY="${SCRAPER_API_KEY:-}"
LANG_CODE="${SCRAPER_LANG:-pt}"
# NOTA: expandir array vazio precisa da guarda ${a[@]+...} — "${AUTH[@]}" puro dá erro de variável
# não definida com 'set -u' no bash 3.2 (macOS padrão), que é o caso comum aqui, já que o uso
# local não precisa de chave de API.
AUTH=(); [ -n "$KEY" ] && AUTH=(-H "X-API-Key: $KEY")

KEYWORD="${1:-}"; LAT="${2:-}"; LON="${3:-}"; DEPTH="${4:-5}"
if [ -z "$KEYWORD" ] || [ -z "$LAT" ] || [ -z "$LON" ]; then
  echo "Uso: $0 \"<termo>\" <lat> <lon> [depth]" >&2
  echo "Exemplo: $0 \"cafeterias em São Paulo SP\" -23.5505 -46.6333 5" >&2
  exit 1
fi
case "$DEPTH" in ''|*[!0-9]*) echo "✗ depth deve ser um número inteiro." >&2; exit 1 ;; esac

# O motor está no ar?
if ! curl -s -m 5 ${AUTH[@]+"${AUTH[@]}"} "$BASE/api/v1/jobs" >/dev/null 2>&1; then
  echo "✗ Motor não acessível em $BASE — rode 'docker compose up -d' primeiro." >&2
  exit 1
fi

echo "▶ Criando job: \"$KEYWORD\" @ $LAT,$LON depth=$DEPTH (extração de e-mails LIGADA)"
# email:true faz o motor visitar o site de cada empresa atrás de e-mails (o campo de lead principal).
# Escapa \ e " para o termo não quebrar o JSON.
KW_JSON="${KEYWORD//\\/\\\\}"; KW_JSON="${KW_JSON//\"/\\\"}"
BODY=$(printf '{"name":"leads-cli","keywords":["%s"],"lang":"%s","zoom":15,"lat":"%s","lon":"%s","fast_mode":false,"radius":10000,"depth":%s,"email":true,"max_time":600}' \
  "$KW_JSON" "$LANG_CODE" "$LAT" "$LON" "$DEPTH")
ID=$(curl -s -X POST "$BASE/api/v1/jobs" ${AUTH[@]+"${AUTH[@]}"} -H "Content-Type: application/json" -d "$BODY" \
     | grep -oE '[a-f0-9-]{36}' | head -1 || true)
[ -n "$ID" ] || { echo "✗ Falha ao criar o job (confira os campos obrigatórios)." >&2; exit 1; }
echo "  id do job: $ID"

echo "▶ Acompanhando (até ~10 min)…"
S=""
for i in $(seq 1 60); do
  # '|| true' mantém o script vivo com 'set -euo pipefail' quando o grep ainda não acha nada
  S=$(curl -s ${AUTH[@]+"${AUTH[@]}"} "$BASE/api/v1/jobs/$ID" | grep -oE '"Status" *: *"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  printf '\r  status: %-10s (tentativa %d)' "${S:-?}" "$i"
  [ "$S" = ok ] && { echo; break; }
  [ "$S" = failed ] && { echo; echo "✗ O job falhou." >&2; exit 1; }
  sleep 10
done
[ "$S" = ok ] || { echo; echo "✗ Tempo esgotado esperando o job." >&2; exit 1; }

# Tira acentos do nome do arquivo ("São Paulo" -> "Sao_Paulo") quando houver python3.
SLUG="$(python3 -c 'import sys, unicodedata as u; print(u.normalize("NFKD", sys.argv[1]).encode("ascii", "ignore").decode())' \
        "$KEYWORD" 2>/dev/null || printf '%s' "$KEYWORD")"
OUT="results-$(printf '%s' "$SLUG" | tr ' /' '__' | tr -cd 'A-Za-z0-9_-').csv"
RAW="$(mktemp)"
echo "▶ Baixando…"
curl -s ${AUTH[@]+"${AUTH[@]}"} "$BASE/api/v1/jobs/$ID/download" -o "$RAW"

# Reduz o CSV bruto de 34 colunas aos 8 campos de lead (descarta coordenadas, IDs, horários, imagens).
if command -v python3 >/dev/null 2>&1; then
  python3 - "$RAW" "$OUT" <<'PY'
import csv, sys
LEAD = ["title", "phone", "emails", "website", "category", "address", "review_rating", "review_count"]
with open(sys.argv[1], newline='', encoding="utf-8", errors="replace") as f:
    rows = list(csv.DictReader(f))
# UTF-8 com BOM para o Excel em português mostrar acentos corretamente.
with open(sys.argv[2], "w", newline='', encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=LEAD); w.writeheader()
    for r in rows:
        w.writerow({k: r.get(k, "") for k in LEAD})
print(f"✓ Pronto — {len(rows)} leads salvos em {sys.argv[2]}")
print("  (nome, telefone, e-mail, site, categoria, endereço, nota, avaliações)\n")
print("Prévia (nome | telefone | e-mail | site):")
for r in rows[:6]:
    print(f"  • {r.get('title','')} | {r.get('phone','')} | {r.get('emails','')} | {r.get('website','')}")
PY
  rm -f "$RAW"
else
  mv "$RAW" "$OUT"
  echo "✓ Pronto — CSV bruto salvo em $OUT (instale python3 para reduzir só aos campos de lead)"
fi
