---
description: Extrai vários termos do Google Maps a partir de um arquivo em um único job e devolve um único CSV de leads.
argument-hint: <arquivo-de-termos> [--city "Cidade, UF"]
---
O usuário quer uma busca **em lote** no Google Maps. Entrada: **$ARGUMENTS** (um arquivo de termos e, opcionalmente, uma cidade).

Use a skill `google-maps-scraper`. A API busca **vários termos em UM job** pelo array `keywords`, então um lote é um job com todos os termos.

1. Confira se o motor está no ar (`curl -s http://localhost:8080/api/v1/jobs`; `docker compose up -d` se não estiver).
2. Leia a lista de termos (um por linha; ignore linhas em branco e com `#`). Se veio `--city`, geocodifique uma vez para `lat`/`lon`. Senão, espere a cidade em cada termo e geocodifique o primeiro.
3. **Pergunte antes sobre redes sociais.** Pule só se o usuário já disse sim ou não: *"Também quer as redes sociais (Instagram / Facebook / LinkedIn / WhatsApp)? Os e-mails já vêm incluídos. (sim / não)"*. Se sim, adicione `--socials`.
4. **Avise, não bloqueie:** um lote com muitos termos é volume alto. Imprima UM aviso curto de que pode limitar o IP temporariamente e sugira proxies para execuções grandes ou repetidas, e **siga**.
5. Faça POST de um único job com o array `keywords` completo, os campos obrigatórios (`max_time` em segundos, `lat`/`lon` como strings), `"lang": "pt"` e **`"email": true`**. Use um `max_time` generoso (ex.: `900`), porque muitos termos com e-mails demoram mais. Acompanhe em segundo plano e baixe.
6. Apresente os 8 campos de lead em uma tabela limpa e salve o arquivo completo no disco.

Dica: `scripts/scrape.py --keywords-file <arquivo> --city "<Cidade, UF>"` já faz tudo isso, com e-mails ligados. Acrescente `--socials` se o usuário disse sim no passo 3.
