# Créditos e atribuição

Esta página lista quem construiu o quê no leadsNEGOCIOS e as licenças que cobrem cada parte.

## Projeto base: Google Maps Scraper Kit

- **Projeto:** google-maps-scraper-kit
- **Autor:** Mahan ([@Mahanaicoach](https://github.com/Mahanaicoach))
- **Repositório:** https://github.com/Mahanaicoach/google-maps-scraper-kit
- **Licença:** MIT License, Copyright (c) 2026 Mahan

O leadsNEGOCIOS é uma adaptação do kit para o português e o mercado brasileiro. Mudanças em relação ao
original: interface, documentação, skill e slash commands em português; resultados do Google Maps em
português por padrão (`--lang pt`); detecção de links de WhatsApp em `--socials`; páginas de contato em
português na passada profunda de e-mails (`/contato`, `/fale-conosco`, `/sobre`, `/quem-somos`); CSV em
UTF-8 com BOM para o Excel; correção de links de compartilhamento do Facebook tomados como perfil;
exemplos com cidades brasileiras e orientação de LGPD.

```
MIT License

Copyright (c) 2026 Mahan (github.com/Mahanaicoach)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Mapa

- **Leaflet 1.9.4** (BSD 2-Clause, © Volodymyr Agafonkin e CloudMade), incluído em
  `web/vendor/leaflet/` com a licença original em `web/vendor/leaflet/LICENSE`.
- **Mapas:** © colaboradores do [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL).

## Motor de extração

- **Projeto:** google-maps-scraper
- **Autor:** **Georgios Komninos** ([@gosom](https://github.com/gosom))
- **Repositório:** https://github.com/gosom/google-maps-scraper
- **Licença:** MIT License, Copyright (c) 2023 Georgios Komninos
- **Imagem Docker usada:** `gosom/google-maps-scraper`

O projeto roda a imagem Docker oficial do motor, sem modificações.

```
MIT License

Copyright (c) 2023 Georgios Komninos

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
