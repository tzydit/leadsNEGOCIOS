---
name: backend-api
description: Boas práticas de backend e APIs web — validação, erros, banco de dados, autenticação e desempenho. Use ao implementar ou revisar endpoints, serviços e acesso a dados.
---

# Backend e APIs

**Ao implementar**
- Valide toda entrada na borda (schema: zod/joi/pydantic etc.); rejeite cedo com 400 e mensagem útil, sem vazar detalhes internos.
- Autorização em todo endpoint que acessa recurso: confira o dono, não só o login.
- Banco: queries parametrizadas/ORM; evite N+1; índices para filtros frequentes; migrações reversíveis; transação quando houver várias escritas dependentes.
- Erros: trate e registre com contexto; nunca engula exceção; status HTTP coerente (400/401/403/404/409/422/500).
- Idempotência em webhooks e pagamentos; timeouts e retry com backoff em chamadas externas.
- Segredos só por variável de ambiente; nada sensível em log.
- Paginação em listagens; rate limit em rotas públicas caras ou de login.

**Ao revisar**: verifique os itens acima apenas no código alterado, com `arquivo:linha`.
