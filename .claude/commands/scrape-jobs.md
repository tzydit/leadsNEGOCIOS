---
description: Lista, baixa ou apaga jobs de busca do Google Maps no motor local.
argument-hint: "[list | download <job-id> | delete <job-id>]"
---
Gerencie os jobs pela API do motor. Pedido: **$ARGUMENTS** (use "list" se vier vazio).

- **list**: `GET http://localhost:8080/api/v1/jobs`. Mostre uma tabela de `ID`, `Name`, `Status`, `Date` (mais recentes primeiro).
- **delete <job-id>**: `DELETE http://localhost:8080/api/v1/jobs/<job-id>` para liberar disco e confirme que voltou HTTP 200.
- **download <job-id>**: `GET .../jobs/<job-id>/download`, salve o CSV e informe quantas linhas tem.

A skill `google-maps-scraper` tem a referência completa da API.
