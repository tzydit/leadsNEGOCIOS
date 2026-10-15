# Guia de instalação: leadsNEGOCIOS

Este guia leva você de uma máquina zerada até uma lista de leads do Google Maps em uns 5 minutos.
A maior parte desse tempo é o Docker baixando a imagem do motor. Uma pessoa ou um agente pode seguir
passo a passo.

---

## 0. Instale os pré-requisitos

| Ferramenta | Para quê | Onde baixar |
|---|---|---|
| **Docker Desktop** | roda o contêiner do extrator | https://www.docker.com/products/docker-desktop |
| **Claude Code** *(opcional, recomendado)* | deixa o Claude controlar o extrator por você | https://claude.com/claude-code |
| **Python 3** *(opcional)* | o CLI `scrape.py` com geocodificação, lotes e redes sociais | https://www.python.org/downloads |

Confira se o Docker está rodando:
```bash
docker --version        # deve mostrar uma versão
docker ps               # NÃO deve dar erro (significa que o daemon está no ar)
```

> **Notas por sistema:**
> - **Apple Silicon (M1/M2/M3):** a imagem do motor é `linux/amd64` e roda por emulação. Se o
>   contêiner não subir, descomente a linha `platform: linux/amd64` no `docker-compose.yml`.
> - **Windows:** use `scripts/scrape.py` (com `py` ou `python`). O script bash `scrape.sh` precisa de
>   **WSL2** ou **Git Bash**.

---

## 1. Baixe o projeto

```bash
git clone https://github.com/tzydit/leadsNEGOCIOS.git
cd leadsNEGOCIOS
```

Crie sua configuração local. É opcional, porque os padrões já funcionam:
```bash
cp .env.example .env
```

---

## 2. Suba o motor

```bash
docker compose up -d
```

Na primeira vez, ele baixa a imagem `gosom/google-maps-scraper` (algumas centenas de MB). Depois, confira:

```bash
docker ps | grep gmaps-scraper          # deve aparecer "Up"
curl http://localhost:8080/api/v1/jobs  # deve mostrar null ou [] (nenhum job ainda) ou os jobs existentes
```

O motor também tem interface web e documentação da API no navegador:
- Interface web: **http://localhost:8080**
- Documentação OpenAPI: **http://localhost:8080/api/docs**

> **Limites e a lei.** O motor faz requisições reais ao Google Maps. Uso leve não tem problema. Jobs
> grandes em sequência, `depth` alto, muitos termos ou execuções agendadas sem proxies podem fazer o
> Google limitar seu IP temporariamente. Sua conta Google não é afetada. Rode um job por vez, comece com
> `depth 5` e use proxies em execuções grandes. Extrair do Google Maps vai contra os Termos de Serviço
> do Google, e telefones e e-mails são dados pessoais, então siga a LGPD. Detalhes:
> [Uso responsável](README.md#uso-responsável).

---

## 3. Sua primeira busca pelo terminal

Script bash. Argumentos: `"<termo>" <lat> <lon> [depth]`:

```bash
./scripts/scrape.sh "cafeterias em São Paulo SP" -23.5505 -46.6333 5
```

Ou o CLI em Python, sem dependências:

```bash
python3 scripts/scrape.py "academias em Curitiba PR" -25.4284 -49.2733 --depth 5
```

Os dois criam o job, acompanham até terminar, baixam o CSV, mantêm os 8 campos de lead e mostram uma
prévia. O resultado completo vai para um arquivo.

**Sem coordenadas.** Passe `--city` e o CLI em Python geocodifica para você:
```bash
python3 scripts/scrape.py "pizzarias em Belo Horizonte MG" --city "Belo Horizonte, MG" --depth 5
```

**Vários termos em um job**, a partir de um arquivo com um termo por linha:
```bash
python3 scripts/scrape.py --keywords-file examples/queries.example.txt --city "São Paulo, SP"
```

**Passe do limite de ~120 resultados por busca.** `--grid 3` divide a cidade em 3 x 3 blocos do mapa.
São 9 jobs, um de cada vez, sem duplicatas:
```bash
python3 scripts/scrape.py "encanadores em Campinas SP" --city "Campinas, SP" --grid 3
```

**Inclua WhatsApp e redes sociais:**
```bash
python3 scripts/scrape.py "salões de beleza em Recife PE" --city "Recife, PE" --socials
```

---

## 4. Rodando pelo Claude Code ou outro agente

Dois arquivos fazem o trabalho:

1. **[CLAUDE.md](CLAUDE.md)** carrega sozinho quando você abre esta pasta no Claude Code. Ele diz ao
   agente o que é o projeto e as regras principais.
2. **[.claude/skills/google-maps-scraper/SKILL.md](.claude/skills/google-maps-scraper/SKILL.md)** é a
   skill. O agente a carrega quando precisa, com o fluxo exato da API e as boas práticas.

Não há nada para conectar. O motor é uma API HTTP local em `http://localhost:8080`, e o agente a chama
com `curl` e o acesso normal ao shell.

```bash
cd leadsNEGOCIOS
claude            # inicia o Claude Code dentro desta pasta
```

Depois peça:
> "Confira se o extrator está rodando e busque **dentistas em Curitiba PR**, depth 10, com uma tabela de nome, telefone e site."

| Comando | O que faz |
|---|---|
| `/scrape <negócio> em <cidade, UF> [depth]` | Uma busca, tabela limpa |
| `/scrape-batch <arquivo> [--city "Cidade, UF"]` | Vários termos em um job |
| `/scrape-setup` | Sobe o motor + verificação de saúde |
| `/scrape-jobs [list \| download <id> \| delete <id>]` | Gerencia jobs |

Os comandos locais e as chamadas a `localhost` estão pré-aprovados em `.claude/settings.json`.

---

## 5. Parar e limpar

```bash
docker compose stop      # pausa (mantém dados e imagem)
docker compose down      # para e remove o contêiner (mantém os volumes/dados)
docker compose down -v   # TAMBÉM apaga os volumes de dados (reset completo)
```

Os resultados se acumulam no volume de dados. Apague jobs antigos para liberar disco:
```bash
curl -X DELETE http://localhost:8080/api/v1/jobs/<job-id>
```

---

## 6. Solução de problemas

| Sintoma | Solução |
|---|---|
| `curl: connection refused` na :8080 | Contêiner parado. `docker compose up -d` e depois `docker ps`. |
| `port is already allocated` / a 8080 já está em uso | Defina `SCRAPER_PORT=8081` no `.env` e rode `docker compose up -d`. O compose e os dois scripts leem o mesmo arquivo. Se o `.env` tiver `SCRAPER_BASE_URL`, apague ou atualize a porta: ela tem prioridade sobre `SCRAPER_PORT`. Os exemplos da skill usam `localhost:8080`, então avise o Claude da porta escolhida. |
| `422 missing max time` | O corpo do job precisa de `max_time` (em **segundos**, ex.: `300`). |
| `422 missing geo coordinates` | O corpo precisa de `lat` e `lon` como **strings**, ex.: `"-23.5505"`. |
| `422` por idioma | `lang` deve ser um código de 2 letras (`pt`, `en`, `es`). |
| Job preso em `working` | Reduza `depth`, ou o Google está limitando o IP — espere ou use proxies. |
| CSV vazio | Termo estreito demais ou coordenadas erradas — aumente `radius` ou corrija `lat`/`lon`. Lembre que no Brasil latitude e longitude são negativas. |
| Acentos estranhos no Excel | O `scrape.py` já grava UTF-8 com BOM. Se abrir um CSV bruto do motor, use Dados → Obter dados → De texto/CSV e escolha UTF-8. |
| Download do Docker lento | Normal na primeira vez; depois fica em cache. |
| `docker: 'compose' is not a docker command` | Falta o plugin Compose. Ele vem com o Docker Desktop. Ou use o `docker run` abaixo. |
| `no space left on device` ao baixar | O disco da **VM** do Docker está cheio. Veja com `docker system df` e libere com `docker image prune -a`. A imagem inclui o Chromium, então reserve alguns GB. |
| `could not install driver: … 404` | Imagem antiga: a `v1.15.0` e anteriores baixam um driver que não existe mais. Use a `v1.18.1` fixada no `docker-compose.yml` e rode `docker compose pull && docker compose up -d`. |

### Sem Compose? Rode o mesmo contêiner com `docker run`

```bash
docker run -d --name gmaps-scraper --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v gmaps_data:/gmapsdata -v gmaps_cache:/opt \
  gosom/google-maps-scraper:v1.18.1 -web -data-folder /gmapsdata
```

Adicione `--platform linux/amd64` em Apple Silicon. Pare com `docker stop gmaps-scraper`.

### Rodando sem Docker (alternativa)

O motor é um único binário Go. Ele serve a **mesma API na mesma porta**, então todos os scripts e
comandos funcionam sem mudança.

```bash
go install github.com/gosom/google-maps-scraper@v1.18.1
google-maps-scraper -web -addr 127.0.0.1:8080 -data-folder ./gmapsdata
```

> Mantenha `-addr 127.0.0.1:8080`. O padrão do binário é `:8080`, que significa **todas as
> interfaces**, e o motor não tem autenticação.

---

## 7. Boas práticas

- Sempre envie `max_time` (segundos) e `lat`/`lon` (strings).
- Comece com `depth 5` e rode um job por vez. Aumente só se precisar.
- Mantenha a extração de e-mails ligada (o padrão). Use `--no-email` para rodar mais rápido sem eles.
- Use proxies em jobs grandes. O motor faz o rodízio.
- Nunca faça commit dos resultados. Eles já estão no `.gitignore`.
- Depois de mexer no `scripts/scrape.py`, rode `python3 scripts/test_scrape.py`.
