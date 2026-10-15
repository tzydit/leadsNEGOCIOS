---
name: google-maps-scraper
description: Extrator de leads do Google Maps. Transforma um tipo de negócio e um lugar em um CSV limpo de empresas locais, controlando o motor gosom/google-maps-scraper que roda localmente em Docker como API REST em localhost:8080. Devolve 8 campos de lead por padrão (nome, telefone, e-mail, site, categoria, endereço, nota e número de avaliações), mais Instagram, Facebook, LinkedIn e WhatsApp opcionais, ou todos os ~34 campos brutos. Use quando o usuário quiser uma lista de leads, "uma lista de [negócios] em [lugar]", dados de empresas locais, enriquecimento de contatos (e-mails, telefones, redes sociais) ou uma cidade inteira além do limite de ~120 resultados por busca do Google. Não use para extrair Instagram, TikTok, YouTube, X ou qualquer outra rede social diretamente.
---

# Extrator do Google Maps

Transforma um tipo de negócio e uma localização em linhas de lead limpas, usando a API de jobs do motor local.

## Modelo mental
O motor (gosom/google-maps-scraper) roda em um contêiner Docker local com uma API REST em
`http://localhost:8080`. Ele não tem autenticação, então fica preso ao localhost. Uma busca é um
**job assíncrono**: crie, acompanhe até terminar e baixe um CSV. Um job pode ter vários termos.
Cada resultado tem até **34 campos brutos**.

## Passo 0: confira se o motor está rodando
```bash
curl -s http://localhost:8080/api/v1/jobs >/dev/null 2>&1 && echo UP || echo DOWN
```
Se `DOWN`: rode `docker compose up -d` na raiz do projeto, espere ~10s e tente de novo. Se o Docker
não estiver instalado, indique o `SETUP.md`.

## Passo 1: crie um job (`POST /api/v1/jobs`)
**Campos obrigatórios. Sem eles a API devolve `422`:**
- `keywords`: array de termos de busca. **Coloque a cidade em cada termo**: `"encanadores em Campinas SP"`.
- `lat`, `lon`: **strings** com as coordenadas da cidade: `"-22.9056"`, `"-47.0608"`.
- `max_time`: inteiro em **segundos**, o limite de tempo do job, ex.: `300`. A API guarda em
  nanossegundos internamente, mas você sempre envia segundos.

**Campos recomendados:**
- `depth` (padrão 10): quanto rolar, ou seja, mais ou menos quantos resultados por termo. Comece com `5`.
- `lang` **`"pt"`** (código de 2 letras; resultados em português), `zoom` `15` (nível cidade),
  `radius` `10000` (metros), `fast_mode` `false`.
- **`email` `true`: ligado por padrão no projeto.** E-mails são o campo de lead mais valioso. O motor
  visita o site de cada empresa para achá-los, o que é um pouco mais lento. Use `false` só para uma
  execução deliberadamente rápida, sem e-mails.

```bash
curl -s -X POST http://localhost:8080/api/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{"name":"job","keywords":["cafeterias em São Paulo SP"],"lang":"pt","zoom":15,
       "lat":"-23.5505","lon":"-46.6333","fast_mode":false,"radius":10000,
       "depth":5,"email":true,"max_time":300}'
# → {"id":"<uuid>"}   (HTTP 201; atenção: "id" minúsculo)
```

> **Trate duas coisas em toda busca:**
> 1. **E-mails: ligados por padrão** (`email:true`). Desligue só se o usuário quiser rapidez.
> 2. **Redes sociais: pergunte antes.** Antes de criar o job, pergunte uma vez se o usuário também quer
>    Instagram, Facebook, LinkedIn e WhatsApp (veja "Redes sociais" abaixo). Nunca pule a pergunta em silêncio.

## Passo 2: acompanhe até terminar (`GET /api/v1/jobs/{id}`)
O campo da resposta é `"Status"` (S maiúsculo). Vai de `working` para `ok` (sucesso) ou `failed`.

> **Regra do ambiente:** a ferramenta Bash **bloqueia `sleep` em primeiro plano**. Rode o loop de
> acompanhamento como comando Bash **em segundo plano** (`run_in_background: true`) e leia o arquivo
> de saída quando for notificado. Nunca acompanhe com `sleep` em primeiro plano.

Trecho de acompanhamento em segundo plano. Ele lê o valor com segurança: casa até a aspa final, sem ancorar em `$`.
```bash
ID="<uuid>"
for i in $(seq 1 40); do
  S=$(curl -s "http://localhost:8080/api/v1/jobs/$ID" | grep -oE '"Status":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "status=$S"
  [ "$S" = ok ] && { echo DONE; break; }
  [ "$S" = failed ] && { echo FAILED; break; }
  sleep 15
done
```

## Passo 3: baixe e processe (`GET /api/v1/jobs/{id}/download`)
```bash
curl -s "http://localhost:8080/api/v1/jobs/$ID/download" -o results.csv
```
Colunas do CSV (34): `input_id, link, title, category, address, open_hours, popular_times, website, phone,
plus_code, review_count, review_rating, reviews_per_rating, latitude, longitude, cid, status,
descriptions, reviews_link, thumbnail, timezone, price_range, data_id, place_id, images, reservations,
order_online, menu, owner, complete_address, about, user_reviews, user_reviews_extended, emails`.

### Devolva só os 8 campos de lead (padrão)
O CSV bruto tem 34 colunas e a maioria é ruído para prospecção. **Por padrão, devolva só os 8 campos
de lead**, os dados usados para contatar e qualificar, e **descarte o resto**:

> `title` (nome), `phone`, `emails`, `website`, `category`, `address`, `review_rating`, `review_count`

**Descarte por padrão.** Mostre só se o usuário pedir: `latitude`/`longitude`, `link`, `plus_code`,
`cid`, `data_id`, `place_id`, `open_hours`, `popular_times`, `reviews_per_rating`, `reviews_link`,
`thumbnail`, `images`, `timezone`, `price_range`, `status`, `input_id`, `complete_address`,
`reservations`, `order_online`, `menu`, `owner`, `about`, `descriptions`, `user_reviews`,
`user_reviews_extended`.

`scripts/scrape.py` já devolve exatamente os 8 campos. Use `--full` para manter todas as colunas, ou
`--fields "a,b,c"` para escolher. Ele **salva um CSV por padrão** (`results-<id>.csv`, UTF-8 com BOM
para abrir certo no Excel); passe `--json` para JSON. Se chamar a API direto, **reduza aos campos de
lead você mesmo** antes de apresentar. Nunca despeje a linha completa de 34 colunas no chat.

### Redes sociais: sempre pergunte (Instagram, Facebook, LinkedIn, WhatsApp)
O Google Maps não traz links de redes sociais, então eles são um passo de enriquecimento: visitar o
`website` de cada empresa e extrair com regex os links de Instagram, Facebook, LinkedIn e WhatsApp
(`wa.me`, `api.whatsapp.com/send?phone=`), normalizados como `https://wa.me/<dígitos>`. **Antes da busca,
pergunte uma vez** se o usuário quer redes sociais, a não ser que ele já tenha dito. Se sim, **use o
script:** `python3 scripts/scrape.py … --socials`.

- **Custo em tokens. Diga isto ao usuário quando ele pedir redes sociais:** a extração custa **0 tokens
  de IA**, porque é HTTP e regex dentro do script. Ela acrescenta **~40–50 tokens por empresa** ao
  *seu* contexto só **se** você carregar as linhas no chat, ex.: ~+2k tokens para 50 leads. É desprezível
  se o arquivo ficar no disco e você mostrar uma amostra.
- **Não** busque cada site com WebFetch para achar redes sociais. Isso lê cada página no seu contexto e
  custa **milhares de tokens**. O script faz de graça, então prefira sempre `--socials`.
- Redes sociais são **opcionais e mais lentas** (uma requisição HTTP por empresa), e a cobertura é
  parcial (~40–70%). Só empresas que linkam suas redes no site têm esses dados, e sem site não há redes.
  Avise se o usuário esperar 100%.

**Atalhos. Prefira estes nos casos comuns:**
- Um termo: `scripts/scrape.sh "<termo>" <lat> <lon> [depth]` (bash) cria, acompanha e baixa de uma vez.
- Geocodificação automática: `python3 scripts/scrape.py "<termo>" --city "<Cidade, UF>" [--depth N]`
  resolve lat/lon pelo OpenStreetMap Nominatim. Você também pode geocodificar e passar as coordenadas.
  **E-mails vêm por padrão** (`--no-email` pula). Adicione `--socials` se o usuário pediu redes sociais.
- **Lote (vários termos, um job):** `python3 scripts/scrape.py --keywords-file <arquivo> --city "<Cidade, UF>"`.
  A API aceita um array `keywords`, então coloque todos os termos em um único job em vez de disparar vários.
- **Outro idioma:** `--lang en` (ou `es`, etc.). O padrão é `pt`.
Use o fluxo manual com curl só para corpos de job personalizados, ex.: definir `proxies`.

**Cidade inteira:** quando o usuário disser todos, toda ou a cidade inteira, ou quando uma busca voltar
com uns 120 resultados (o limite por busca do Google), use
`python3 scripts/scrape.py "<termo>" --city "<Cidade, UF>" --grid 3`. Ele divide a cidade em 3 x 3
blocos (9 jobs) e remove duplicatas por `place_id`. Os blocos rodam um de cada vez, então o grid é mais
lento e tem mais chance de esbarrar em limites: avise uma vez, não bloqueie.

**Passada profunda de e-mails:** ligada por padrão sempre que os e-mails estão ligados. Linhas com site
mas sem e-mail têm as páginas de contato/sobre verificadas (`/contato`, `/fale-conosco`, `/sobre`,
`/quem-somos` e equivalentes em inglês), e o script imprime a taxa de acerto. `--no-deep-emails` pula.

## Outros endpoints
- `GET /api/v1/jobs` lista jobs. `DELETE /api/v1/jobs/{id}` apaga um job e libera disco.
- Interface web e documentação OpenAPI: `http://localhost:8080` e `http://localhost:8080/api/docs`.

## Boas práticas (da documentação original)
- **Depth:** `depth` maior traz mais resultados, mas é mais lento e tem mais chance de bloqueio. Comece
  com 5 e aumente se precisar.
- **Um job por vez** localmente. Muitos jobs simultâneos sem proxies levam o Google a limitar.
- **Extração de e-mails (`email:true`)** visita cada site, então é mais lenta. Fica **ligada por
  padrão** porque e-mail é o campo de lead principal. Use `--no-email` (script) ou `email:false`
  (API) para rodar rápido.
- **`fast_mode:true`** devolve dados reduzidos, até ~21 resultados por busca, mais rápido.
- **Proxies:** para jobs grandes ou repetidos, defina `"proxies"` (array de URLs `socks5://`, `http://`
  ou `https://`, com autenticação opcional). O motor faz rodízio. É a principal defesa contra limites.
- **`zoom` e `radius`** definem a área ao redor de `lat`/`lon`. Aumente `radius` se vierem poucos resultados.
- **Avaliações estendidas** existem, mas são pesadas. Ative só se o usuário pedir o texto das avaliações.

## Limites de taxa, bloqueios e proxies (leia antes de jobs grandes)
O motor faz requisições reais ao Google Maps. A única nota formal do projeto original é um aviso:
> "Please use this scraper responsibly and in accordance with applicable laws and regulations. Unauthorized scraping may violate terms of service."

**Não há limite oficial publicado**, então seja conservador:
- O Google pode **limitar seu IP temporariamente** se você extrair rápido ou demais. Passa em minutos
  ou horas e **não** afeta a conta Google do usuário, mas os jobs falham nesse meio-tempo.
- **Sinais de bloqueio:** jobs `failed`, resultados vazios ou curtos demais, ou queda repentina de
  linhas em relação a uma execução idêntica. Ao ver isso, **recue** (pause, reduza depth) ou use proxies.
- Localmente, rode **um job por vez** e comece com `depth 5`.

**Quando usar proxies:** jobs grandes, muitos termos, execuções repetidas ou agendadas, ou depois de
sinais de bloqueio. Formato: `"proxies": ["socks5://user:pass@host:port", "http://host2:port2"]`.

## Segurança e limites de uso
- **Avise, não bloqueie.** Quando o pedido for grande (depth alto, muitos termos, repetições, grid ou
  `email:true`), **siga em frente**, mas antes imprima UM aviso curto sobre limites temporários de IP e
  sugira proxies. **Não** trave nem exija confirmação só porque a busca é grande. Recuse **apenas** usos
  claramente abusivos ou ilegais (vigiar pessoas, spam, assédio).
- **Nunca exponha** a API além do `localhost` sem proxy com autenticação. Nunca imprima uma chave de API.
- **Dados pessoais:** e-mails e telefones extraídos são dados pessoais. Se o usuário for armazenar ou
  contatar, lembre uma vez de seguir a **LGPD** (base legal, opção de descadastro, lista de supressão)
  e, para contatos fora do Brasil, GDPR, CCPA e CAN-SPAM. Não ajude com spam ou assédio.
- **Termos de Serviço do Google:** extrair dados do Google Maps vai contra eles. Mantenha o volume
  moderado, trate a saída como leads a verificar e não revenda dados brutos do Google.
- **Higiene de saída:** não despeje CSVs grandes no chat. Salve no disco, resuma as contagens e mostre
  algumas linhas. Remova duplicatas por `place_id`/`cid` antes de armazenar.
- **Disco:** os resultados se acumulam no volume do Docker. Ofereça de tempos em tempos apagar jobs antigos.

## Solução de problemas
- `422 missing max time`: adicione `max_time` (segundos). `422 missing geo coordinates`: adicione `lat`/`lon` como strings.
- `422` por idioma: use um código de 2 letras em `lang` (`pt`, `en`, `es`).
- Preso em `working`: reduza `depth`, aumente `max_time`, ou o IP está limitado (use proxies ou espere).
- CSV vazio: termo estreito demais ou coordenadas erradas. Aumente `radius` ou corrija as coordenadas.
- Conexão recusada: o contêiner está parado. Rode `docker compose up -d`.
