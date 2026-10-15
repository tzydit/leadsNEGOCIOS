---
description: Extrai empresas do Google Maps para um tipo de negócio em uma cidade e devolve os 8 campos de lead em tabela e CSV.
argument-hint: <tipo de negócio> em <cidade, UF> [depth]
---
O usuário quer uma lista de leads do Google Maps. Pedido: **$ARGUMENTS**

Use a skill `google-maps-scraper` e siga estes passos:

1. **Confira o motor:** `curl -s http://localhost:8080/api/v1/jobs`. Se estiver fora, rode `docker compose up -d` na raiz do projeto, espere ~10s e tente de novo.
2. **Extraia** o tipo de negócio e a cidade do pedido. Descubra a **latitude/longitude** da cidade (como strings), ou deixe o script geocodificar com `--city`.
3. **Pergunte sobre redes sociais antes de buscar, sempre.** Faça UMA pergunta curta:
   *"Quer que eu também pegue as redes sociais (Instagram / Facebook / LinkedIn / WhatsApp)? Os e-mails já vêm por padrão. (sim / não)"*
   Espere a resposta. **Pule a pergunta só se** o usuário já disse sim ou não no pedido.
   Se **sim**, adicione `--socials` no passo 4. Se **não**, deixe de fora. Redes sociais custam zero tokens de IA e uma requisição HTTP extra por site (veja a skill).
4. **Crie o job com e-mails ligados** (`"email": true`; e-mail é o campo de lead mais valioso). Campos obrigatórios: `keywords` (com a cidade em cada termo), `lat`/`lon` (strings), `max_time` (segundos, padrão `300`), `depth` (o número do pedido, senão `5`), `lang` `"pt"`. Caminho mais fácil: `python3 scripts/scrape.py "<termo>" --city "<Cidade, UF>" --depth <n>` (e-mails já ligados; acrescente `--socials` se o usuário disse sim no passo 3).
5. **Acompanhe até o fim em segundo plano.** A ferramenta Bash bloqueia `sleep` em primeiro plano, então use `run_in_background: true` e leia o arquivo de saída quando for notificado. Depois baixe o CSV.
6. **Salve um CSV.** `scripts/scrape.py` grava `results-<id>.csv` por padrão. Se usar a API direto, salve você mesmo os campos de lead em um `.csv`. Depois **apresente só os 8 campos de lead** em uma tabela markdown limpa: `nome (title), phone, emails, website, category, address, review_rating, review_count`, mais `instagram, facebook, linkedin, whatsapp` se pediu redes sociais. **Descarte o resto**, principalmente `latitude`/`longitude`, IDs, horários, imagens e avaliações. Nunca despeje o CSV de 34 colunas no chat. Mostre algumas linhas e o caminho do CSV.

**Todos, toda ou cidade inteira:** adicione `--grid 3` (3 x 3 blocos, um job por vez, sem duplicatas) para passar do limite de ~120 resultados por busca do Google. Avise uma vez que é mais lento e tem mais chance de esbarrar em limites, e siga.

**E-mails:** ligados por padrão. Algumas empresas não publicam e-mail, então a cobertura é parcial. Para rodar rápido sem e-mails, passe `--no-email`.

**Redes sociais:** quando o usuário disser sim, `scripts/scrape.py … --socials` adiciona Instagram, Facebook, LinkedIn e WhatsApp. **Nunca** use WebFetch em cada site para achar redes sociais; isso custa milhares de tokens.

**Avise, não bloqueie:** se o pedido for grande (depth alto, muitos termos, repetições), imprima UM aviso curto de que uso pesado pode fazer o Google limitar o IP temporariamente e sugira proxies. Depois **faça a busca**. Recuse só usos claramente abusivos (vigiar pessoas, spam, assédio). Se o usuário for armazenar ou contatar os dados, lembre uma vez que são dados pessoais (LGPD) e que extrair do Google Maps vai contra os Termos de Serviço do Google.
