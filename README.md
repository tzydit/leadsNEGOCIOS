# leadsNEGOCIOS

**Extrator de leads do Google Maps, gratuito e open-source, que roda no seu próprio computador.**
Diga um tipo de negócio e uma cidade. Receba um CSV pronto para prospecção com nome, telefone, e-mail,
site, categoria, endereço, nota e número de avaliações. Adicione `--socials` para Instagram, Facebook,
LinkedIn e WhatsApp.

Sem chave da API do Google Maps, sem créditos de SaaS, sem dados saindo da sua máquina. Um comando
Docker sobe o motor. Depois, rode pelo terminal ou deixe o Claude Code (ou Codex, Cursor) fazer tudo
por você em linguagem natural.

> Adaptação para o português e o mercado brasileiro do
> [Google Maps Scraper Kit](https://github.com/Mahanaicoach/google-maps-scraper-kit), usando o motor
> [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper). Veja [CREDITS.md](CREDITS.md).

| Objetivo | Comece aqui |
|---|---|
| Ter uma lista de leads em 5 minutos | [Início rápido](#início-rápido) |
| Deixar um agente de IA rodar a busca | [Uso com o Claude Code](#uso-com-o-claude-code-ou-outro-agente) |
| Buscar vários termos ou a cidade inteira | [Lotes e o CLI em Python](#lotes-e-o-cli-em-python) |
| Saber o que vem e onde para | [O que você recebe](#o-que-você-recebe) e [Limites reais](#limites-reais) |
| Seguir uma receita pronta | [Guias e receitas](docs/README.md) |

---

## Início rápido

Requer o [Docker Desktop](https://www.docker.com/products/docker-desktop). O Python 3 é opcional e usa
só a biblioteca padrão.

```bash
git clone https://github.com/tzydit/leadsNEGOCIOS.git
cd leadsNEGOCIOS
docker compose up -d
./scripts/scrape.sh "cafeterias em São Paulo SP" -23.5505 -46.6333 5
```

Sem as coordenadas? Deixe o CLI em Python geocodificar a cidade:

```bash
python3 scripts/scrape.py "dentistas em Curitiba PR" --city "Curitiba, PR" --depth 5 --socials
```

Precisa da cidade inteira, e não só dos primeiros 120? Adicione `--grid 3`:

```bash
python3 scripts/scrape.py "dentistas em Curitiba PR" --city "Curitiba, PR" --grid 3
```

### Exemplo de saída

`results-1a2b3c4d.csv` (linhas ilustrativas):

| title | phone | emails | website | category | address | review_rating | review_count |
|---|---|---|---|---|---|---|---|
| Café Exemplo | (11) 3555-0101 | contato@example.com | example.com | Cafeteria | Av. Paulista, 1000, São Paulo - SP | 4.7 | 812 |
| Torrefação Modelo | (11) 3555-0102 | oi@example.org | example.org | Café | R. Augusta, 200, São Paulo - SP | 4.5 | 356 |

`--socials` adiciona as colunas `instagram`, `facebook`, `linkedin` e `whatsapp` (no formato
`https://wa.me/55...`). `--full` mantém todos os ~34 campos brutos, incluindo horários, coordenadas,
faixa de preço e avaliações. O CSV sai em UTF-8 com BOM, então abre com acentos corretos no Excel.

Passo a passo completo, notas por sistema e solução de problemas: [SETUP.md](SETUP.md).

---

## Uso com o Claude Code ou outro agente

O projeto traz uma [skill do Claude Code](.claude/skills/google-maps-scraper/SKILL.md) que ensina ao
agente a API de jobs, os campos obrigatórios, o acompanhamento, a limpeza do CSV e os cuidados com
limites de taxa. Ela também funciona com Codex, Cursor e outras ferramentas compatíveis com
[Agent Skills](https://agentskills.io).

Abra a pasta no Claude Code. A skill e os quatro slash commands carregam automaticamente:

```bash
cd leadsNEGOCIOS
claude
```

Depois peça em linguagem natural:

> Busque academias em Curitiba e me dê telefones, e-mails e sites.

O agente confere se o motor está no ar (e sobe se não estiver), monta o job, acompanha em segundo plano,
baixa o CSV, mantém os 8 campos de lead e entrega uma tabela limpa mais o arquivo.

| Slash command (Claude Code) | Ação |
|---|---|
| `/scrape <negócio> em <cidade, UF> [depth]` | Uma busca, devolve tabela e CSV |
| `/scrape-batch <arquivo-de-termos> [--city "Cidade, UF"]` | Vários termos em um job |
| `/scrape-setup` | Sobe o motor e faz a verificação de saúde |
| `/scrape-jobs [list \| download <id> \| delete <id>]` | Lista, baixa ou apaga jobs |

---

## O que você recebe

| | |
|---|---|
| **8 campos de lead por padrão** | nome, telefone, e-mail, site, categoria, endereço, nota, nº de avaliações. O motor captura ~34 campos brutos; `--full` mantém todos. |
| **Resultados em português** | `lang: "pt"` por padrão (categorias como "Dentista", "Padaria"). `--lang en` para outro idioma. |
| **E-mails, ligados por padrão** | Visita o site de cada empresa e pega os e-mails publicados. Uma segunda passada verifica páginas de contato e "sobre" (`/contato`, `/fale-conosco`, `/sobre`, `/quem-somos`) das linhas ainda sem e-mail e mostra a taxa de acerto. |
| **WhatsApp e redes sociais** | `--socials` acha Instagram, Facebook, LinkedIn e links de WhatsApp (`wa.me`, `api.whatsapp.com`) em código (HTTP + regex). Zero tokens de IA. |
| **Além do limite de 120** | `--grid 3` divide a cidade em 3 x 3 blocos do mapa, roda um de cada vez e remove duplicatas por `place_id`. |
| **Geocodificação automática** | Digite o nome da cidade. As coordenadas vêm do OpenStreetMap. |
| **Lotes** | Vários termos, um job, um CSV. |
| **Rodízio de proxies** | Embutido no motor para execuções grandes ou repetidas. `socks5`, `socks5h`, `http`, `https`. |
| **Feito para agentes** | Uma skill mais quatro slash commands. O agente cria, acompanha, baixa, limpa e apresenta. |
| **Padrões seguros** | API presa ao `127.0.0.1`, resultados ignorados pelo git, cuidados com limites e LGPD na skill. |

### Lotes e o CLI em Python

`scripts/scrape.py` é um CLI em Python sem dependências: buscas únicas, lotes, geocodificação, redes
sociais e saída em CSV. Funciona em macOS, Linux e Windows.

```bash
python3 scripts/scrape.py --keywords-file examples/queries.example.txt --city "São Paulo, SP"
```

Um termo por linha. Um job. Um CSV. Todas as opções: [docs/cli-python.md](docs/cli-python.md).

---

## Limites reais

- **Cerca de 120 resultados por busca.** O Google Maps para de rolar em uns 120 resultados por busca.
  O limite é do Google, não do projeto. `--grid` resolve: divide a cidade em N x N blocos, roda uma
  busca por bloco e remove duplicatas por `place_id`. Os blocos rodam um de cada vez, então o grid é
  mais lento e tem mais chance de esbarrar em limites de taxa.
- **E-mail só quando a empresa publica um.** Sem site, ou com site sem e-mail visível, a célula
  `emails` vem vazia. Muitas empresas brasileiras atendem só por WhatsApp: use `--socials` para pegar o
  link quando o site tiver um. Bios do Instagram não são lidas.
- **Limites de taxa existem.** Uso pesado sem proxies pode fazer o Google limitar seu IP por minutos ou
  horas. Sua conta Google não é afetada. Veja [Uso responsável](#uso-responsável).
- **Apple Silicon roda o motor por emulação amd64.** Funciona, só é mais lento. O [SETUP.md](SETUP.md)
  tem a alternativa nativa.

---

## Perguntas frequentes

**É grátis?** Sim. O projeto é MIT e o motor é open-source. Sem créditos, assinaturas ou chaves de API.
Você só precisa do Docker.

**Preciso de chave da API do Google Maps / Places?** Não. O projeto usa um navegador headless direto no
Google Maps, então não há cota nem cobrança.

**Preciso do Claude Code?** Não. Ele deixa tudo automático com a skill e os slash commands, mas
`scripts/scrape.py` e `scripts/scrape.sh` rodam sozinhos em qualquer terminal.

**Funciona no Windows, Linux e Mac com Apple Silicon?** Sim, onde o Docker rodar. No Windows, use
`scripts/scrape.py` (com `py` ou `python`), ou rode o `scrape.sh` no WSL2 ou Git Bash.

**É legal extrair dados do Google Maps?** Vai contra os Termos de Serviço do Google, e telefones e
e-mails são dados pessoais. Leia [Uso responsável](#uso-responsável) e siga a LGPD. Isto não é
orientação jurídica.

---

## Uso responsável

O projeto roda um extrator real contra o Google Maps. Uso leve não tem problema. Uso pesado sem proxies
pode fazer seu IP ser **limitado temporariamente** (minutos a horas). Sua conta Google não é afetada.

- Rode um job por vez. Comece com `depth 5` e aumente só se precisar.
- Fique atento a sinais de bloqueio: jobs `failed`, resultados vazios, ou bem menos linhas que uma
  execução idêntica anterior.
- Use proxies em execuções grandes ou repetidas. O motor faz o rodízio automaticamente:
  ```json
  "proxies": ["socks5://user:pass@host:port", "http://host2:port2"]
  ```
- Trate a saída como leads a verificar, não como base para revender. Telefones e e-mails são dados
  pessoais: siga a **LGPD** (Lei 13.709/2018) — tenha base legal (ex.: legítimo interesse documentado),
  identifique-se no primeiro contato, ofereça descadastro e respeite quem pedir para sair. Para
  contatos fora do Brasil, siga também GDPR, CCPA e CAN-SPAM.

Em pedidos grandes, o agente avisa o risco e sugere proxies, depois segue. Ele só recusa usos
claramente abusivos.

---

<details>
<summary><strong>Estrutura do projeto</strong></summary>

```
leadsNEGOCIOS/
├── docker-compose.yml      motor local em 127.0.0.1:8080
├── .env.example            modelo de configuração
├── scripts/
│   ├── scrape.py           CLI Python: única, lote, geocodificação, redes sociais, CSV
│   ├── scrape.sh           CLI bash: busca única
│   └── test_scrape.py      testes offline (python3 scripts/test_scrape.py)
├── examples/               corpo de job de exemplo e lista de termos em lote
├── docs/                   guias e receitas
├── .claude/
│   ├── settings.json       comandos locais pré-aprovados
│   ├── commands/           /scrape, /scrape-batch, /scrape-setup, /scrape-jobs
│   └── skills/google-maps-scraper/SKILL.md
├── CLAUDE.md               instruções do projeto para o Claude Code
├── CREDITS.md              atribuição e licenças do kit base e do motor
└── SETUP.md                guia completo de instalação
```

</details>

## Licença

MIT. Componentes de terceiros e licenças: [CREDITS.md](CREDITS.md).
