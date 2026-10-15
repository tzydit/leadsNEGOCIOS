# Como os e-mails e o WhatsApp são encontrados

As fichas do Google Maps não têm campo de e-mail nem de redes sociais. O projeto coleta esses dados no
site de cada empresa, sempre em código Python (zero tokens de IA).

## E-mails (ligados por padrão)

1. O motor visita o site de cada ficha e pega os e-mails que conseguir ler.
2. A **passada profunda** pega cada linha com site mas ainda sem e-mail. Ela lê a página inicial e
   depois até 3 páginas de contato/sobre do mesmo site: primeiro os links encontrados com palavras como
   "contato", "fale conosco", "sobre", "quem somos", "atendimento", "contact", "about"; depois os
   caminhos fixos `/contato`, `/fale-conosco`, `/contact`, `/sobre`, `/quem-somos`, `/about`.

Ela lê links `mailto:` e texto puro, descarta lixo (nomes de imagem, endereços de exemplo como
`seuemail@...` ou `@seudominio.com.br`, domínios de construtores de site), ordena os e-mails do próprio
domínio primeiro e guarda no máximo 3 por linha. No fim, mostra a taxa de acerto:

```
e-mails: 41/80 do motor, +12 das páginas de contato = 53/80 (66%)
```

`--no-deep-emails` pula a passada profunda. `--no-email` pula os e-mails por completo.

## WhatsApp e redes sociais (`--socials`)

Com `--socials`, a página inicial de cada site é lida uma vez (reaproveitada da passada de e-mails) e
quatro colunas são adicionadas:

| Coluna | O que procura |
|---|---|
| `instagram` | `instagram.com/<perfil>` (ignora posts, reels e links genéricos) |
| `facebook` | `facebook.com/<página>`, incluindo `pt-br.facebook.com` (ignora botões de compartilhar) |
| `linkedin` | `linkedin.com/company/…`, `/in/…`, `/school/…` |
| `whatsapp` | `wa.me/<número>`, `api.whatsapp.com/send?phone=…`, `web.whatsapp.com/send?phone=…`, `whatsapp://send?phone=…`, normalizado como `https://wa.me/<dígitos>` |

O WhatsApp só é preenchido quando o site tem um link de WhatsApp. O projeto **não** supõe que o
telefone do Google Maps seja WhatsApp.

## O que esperar

- E-mails e redes sociais só aparecem quando a empresa os publica no site. Sem site, sem dados.
- Cobertura típica de redes sociais: 40–70% das empresas com site.
- Esses dados são pessoais: siga a LGPD antes de entrar em contato. Veja o [Uso responsável](../README.md#uso-responsável).
