# Receita: leads de dentistas e clínicas odontológicas

Uma lista de consultórios com telefone, e-mail, site, endereço, nota e avaliações, para uma cidade.

## Passo 1: uma busca de teste

```bash
docker compose up -d
python3 scripts/scrape.py "dentistas em Curitiba PR" --city "Curitiba, PR" --depth 5
```

Confira a prévia e a taxa de acerto de e-mails. Se estiver bom, amplie.

## Passo 2: a cidade inteira

Uma busca para em uns 120 resultados. Divida a cidade em 3 x 3 blocos:

```bash
python3 scripts/scrape.py "dentistas em Curitiba PR" --city "Curitiba, PR" --grid 3
```

São 9 jobs, um de cada vez. Duplicatas são removidas por `place_id` e linhas fora da cidade são descartadas.

## Passo 3: WhatsApp e redes sociais

```bash
python3 scripts/scrape.py "dentistas em Curitiba PR" --city "Curitiba, PR" --grid 3 --socials
```

## Especialidades em um job

O arquivo de exemplo já traz dentistas, ortodontistas, clínicas odontológicas e odontopediatras:

```bash
python3 scripts/scrape.py --keywords-file examples/queries.example.txt --city "São Paulo, SP"
```

## Colunas que importam

- `title` e `phone`: com quem falar e para onde ligar.
- `emails`: o e-mail publicado do consultório.
- `whatsapp`: o canal preferido de muitas clínicas no Brasil (com `--socials`).
- `category`: separa clínico geral de ortodontia, implantes e outras especialidades.
- `review_rating` e `review_count`: indicam quão estabelecido é o consultório.

Telefones e e-mails são dados pessoais: siga a LGPD antes de prospectar.
