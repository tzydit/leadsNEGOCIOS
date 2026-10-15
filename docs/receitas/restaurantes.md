# Receita: leads de restaurantes, bares e cafeterias

Ideal para quem vende delivery, cardápio digital, sistemas de PDV, fornecimento ou marketing para
food service.

## Vários tipos em um job

Crie um arquivo `restaurantes.txt`:

```
restaurantes em Porto Alegre RS
pizzarias em Porto Alegre RS
hamburguerias em Porto Alegre RS
bares em Porto Alegre RS
cafeterias em Porto Alegre RS
```

E rode:

```bash
python3 scripts/scrape.py --keywords-file restaurantes.txt --city "Porto Alegre, RS" --socials
```

Um job, um CSV. Com 10 termos ou mais, o script avisa sobre limites de taxa e segue.

## Cidade inteira para um tipo

```bash
python3 scripts/scrape.py "pizzarias em Porto Alegre RS" --city "Porto Alegre, RS" --grid 3 --socials
```

## Colunas que importam

- `instagram` e `whatsapp`: restaurantes costumam ser mais ativos aqui do que por e-mail.
- `review_count`: separa casas movimentadas de casas novas.
- `--full` traz `open_hours`, `price_range`, `menu` e `order_online`, úteis para qualificar
  (ex.: quem ainda não tem pedido online).

Telefones e e-mails são dados pessoais: siga a LGPD antes de prospectar.
