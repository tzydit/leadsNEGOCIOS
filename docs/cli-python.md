# CLI em Python: todas as opções

`scripts/scrape.py` transforma um termo e um lugar em um CSV de leads usando só a biblioteca padrão.
Ele controla o motor rodando localmente no Docker, então não há chave de API, `pip install` nem dados
saindo da sua máquina.

```bash
docker compose up -d
python3 scripts/scrape.py "academias em Curitiba PR" -25.4284 -49.2733 --depth 5
python3 scripts/scrape.py "cafeterias em Belo Horizonte MG" --city "Belo Horizonte, MG"
python3 scripts/scrape.py --keywords-file examples/queries.example.txt --city "São Paulo, SP"
```

No Windows, use os mesmos comandos com `py` ou `python`.

| Opção | O que faz |
|---|---|
| `keyword` | A busca, com a cidade incluída, ex.: `"padarias em Salvador BA"`. |
| `lat`, `lon` | Coordenadas. Opcionais com `--city`. No Brasil, as duas são negativas. |
| `--city` | Geocodifica o nome da cidade pelo OpenStreetMap. Use `"Cidade, UF"`. |
| `--depth` | Quanto rolar cada busca. Padrão `5`. Maior é mais lento e tem mais risco de bloqueio. |
| `--lang` | Idioma de 2 letras dos resultados. Padrão `pt`. |
| `--no-email` | Pula a extração de e-mails para rodar mais rápido. E-mails vêm ligados por padrão. |
| `--no-deep-emails` | Pula a passada extra nas páginas de contato e "sobre". |
| `--grid N` | Divide a área de `--city` em N x N blocos, um job cada, sem duplicatas. Precisa de `--city`. Máx. 10. |
| `--max-time` | Limite de tempo do job em segundos. Padrão `600`. |
| `--out` | Arquivo de saída. Padrão `results-<id>.csv`. Extensão `.json` grava JSON. |
| `--json` | Grava JSON em vez de CSV. |
| `--full` | Mantém as ~34 colunas brutas em vez dos 8 campos de lead. |
| `--fields` | Colunas separadas por vírgula, substituindo os campos de lead. |
| `--socials` | Adiciona Instagram, Facebook, LinkedIn e WhatsApp a partir de cada site. Mais lento. Zero tokens de IA. |
| `--keyword` | Termo extra no mesmo job. Pode repetir. |
| `--keywords-file` | Lê um termo por linha de um arquivo. Um job, um CSV. |
| `--job ID` | Não busca de novo: baixa um job que já terminou e só limpa, completa e-mails e redes sociais. Útil se a janela fechou no meio. |

Variáveis de ambiente (ou `.env`): `SCRAPER_PORT`, `SCRAPER_BASE_URL`, `SCRAPER_API_KEY`. O
`scrape.sh` também aceita `SCRAPER_LANG` (padrão `pt`).

## O que esperar

- O Google Maps devolve uns 120 resultados por busca. Use `--grid 3` para cobrir a cidade inteira.
- Os blocos do grid rodam um de cada vez: mais lento e com mais risco de limite que uma busca só.
- E-mails só aparecem quando a empresa publica um no site. Muitas linhas virão com `emails` vazio.
- A geocodificação usa o Nominatim (OpenStreetMap), que permite ~1 requisição por segundo.
- Extrair do Google Maps vai contra os Termos de Serviço do Google. Leia o [Uso responsável](../README.md#uso-responsável).

## Testes

```bash
python3 scripts/test_scrape.py
```

Roda offline, contra um motor simulado. Não precisa de rede nem de Docker.
