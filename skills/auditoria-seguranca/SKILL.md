---
name: auditoria-seguranca
description: Auditoria de segurança de aplicações web (OWASP Top 10, segredos, dependências, autenticação). Use para analisar friamente a segurança de um projeto ou de uma mudança.
---

# Auditoria de segurança web

Postura: atacante cético. Só reporte o que tem caminho de exploração plausível.

**Mapa rápido (barato)**: identifique stack, pontos de entrada (rotas, handlers, forms, webhooks, jobs) e onde há auth. Use `grep` em vez de ler tudo.

**Checklist**
- Injeção: SQL/NoSQL/comando/template montados com string; `eval`, `exec`, `child_process` com entrada do usuário.
- XSS: `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, templates sem escape, URLs `javascript:`.
- AuthN/AuthZ: rotas sem verificação, IDOR (id do recurso sem checar dono), JWT sem validar assinatura/expiração, sessão sem `HttpOnly`/`Secure`/`SameSite`.
- CSRF em rotas que mudam estado com cookie; CORS `*` com credenciais.
- SSRF: fetch de URL vinda do usuário; path traversal em upload/download (`../`).
- Segredos: chaves/tokens no código, `.env` versionado, logs com dados sensíveis.
- Config: headers ausentes (CSP, HSTS, X-Content-Type-Options), debug ligado em produção, mensagens de erro com stack.
- Dependências: `npm audit --omit=dev` / `pip-audit` se disponível; aponte só versões com CVE relevante ao uso.
- Rate limit / brute force em login, reset de senha e endpoints caros.

**Formato** (ordene por severidade)
```
[CRÍTICA|ALTA|MÉDIA|BAIXA] arquivo:linha — vulnerabilidade
  Exploração: passo concreto
  Correção: o mínimo que resolve
```
Se nada relevante: diga "Nenhum achado explorável" e liste o que foi verificado em 1 linha.
Termine com `VEREDITO: APROVADO` (sem CRÍTICA/ALTA) ou `VEREDITO: MUDANCAS_NECESSARIAS`.
