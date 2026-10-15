# CLAUDE.md: leadsNEGOCIOS

Você está trabalhando dentro do **leadsNEGOCIOS**. O projeto roda localmente um extrator do Google Maps
para geração de leads, e você o controla para o usuário. Responda em português do Brasil.

## O que é o projeto
Uma instalação Docker local do motor open-source `gosom/google-maps-scraper`, exposta como API REST em
**`http://localhost:8080`**, mais uma skill que ensina você a usá-la. Ela extrai **apenas fichas de
empresas do Google Maps**, não redes sociais.

## Quando o usuário pedir empresas, uma lista de lugares ou dados de leads
**Carregue e siga a skill `google-maps-scraper`** (`.claude/skills/google-maps-scraper/SKILL.md`).
Ela tem o fluxo exato da API, os campos obrigatórios e as regras de boas práticas e segurança. Não
escreva as chamadas da API de memória. Use a skill.

## Slash commands
O projeto traz quatro comandos em `.claude/commands/` ligados à skill: `/scrape` (uma busca),
`/scrape-batch` (vários termos, um job), `/scrape-setup` (subir o motor), `/scrape-jobs` (listar ou apagar).
Os comandos locais estão pré-aprovados em `.claude/settings.json`, então você pode rodá-los sem pedir permissão.

## Limites de taxa: avise, não bloqueie
Se o pedido for grande (`depth` alto, muitos termos, repetições, grid ou `email:true`), **siga em frente**,
mas antes imprima UM aviso curto de que uso pesado pode fazer o Google limitar o IP do usuário
temporariamente, e sugira proxies. NÃO trave nem exija confirmação para uma busca grande normal. Recuse
só usos claramente abusivos (vigiar pessoas, spam). A skill tem a orientação completa.

## Fatos que você não pode errar
- Base da API: `http://localhost:8080`, **sem autenticação** porque está presa ao localhost. Nunca exponha publicamente.
- Crie um job com `POST /api/v1/jobs`. Estes campos são **obrigatórios**, senão volta 422:
  `max_time` (em **segundos**, ex.: `300`), `lat` e `lon` (como **strings**) e `keywords` (array).
- Use `"lang": "pt"` (código de 2 letras) para resultados em português.
- A resposta da criação é `{"id":"<uuid>"}` (`id` minúsculo). Consulte com `GET /api/v1/jobs/{id}`; o campo é `"Status"` e vira `"ok"` ao terminar.
- **Acompanhe em segundo plano.** A ferramenta Bash bloqueia `sleep` em primeiro plano. Rode o loop
  como comando em segundo plano (`run_in_background: true`) e leia o arquivo de saída quando notificado.
- Antes de um job grande, diga o custo uma vez: tempo e risco de limitação de IP. Depois siga.
- E-mails e telefones extraídos são **dados pessoais** (LGPD). Não despeje CSVs grandes no chat: resuma e salve no disco.

## Interface com mapa
`python3 scripts/app.py` abre http://localhost:8090: o usuário desenha a área no mapa, digita o tipo
de negócio e baixa o CSV. Se o usuário quiser escolher a área visualmente, indique essa página.

## Testes
`python3 scripts/test_scrape.py` e `python3 scripts/test_app.py` rodam as suítes offline (sem rede,
sem Docker). Rode depois de mexer em `scripts/` ou `web/`.

## Setup
Se o contêiner não estiver rodando: `docker compose up -d` e confirme com `curl http://localhost:8080/api/v1/jobs`.
O `SETUP.md` tem o passo a passo completo.

## Atribuição
O motor é o `gosom/google-maps-scraper` (MIT, © Georgios Komninos), rodando pela imagem Docker oficial.
O projeto é baseado no Google Maps Scraper Kit (MIT, © Mahan). Mantenha `CREDITS.md` e `LICENSE` intactos.
