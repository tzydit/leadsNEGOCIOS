---
name: analise-fria
description: Análise fria e honesta de um projeto inteiro — arquitetura, riscos, dívida técnica e prioridades. Use quando pedirem um diagnóstico do projeto.
---

# Análise fria do projeto

Objetivo: diagnóstico que um sênior exigente daria. Sem elogio, sem enrolação.

**Como explorar (barato)**
1. `README`, manifesto (`package.json`, `pyproject`, etc.), estrutura de pastas (2 níveis).
2. Pontos de entrada e 2–3 fluxos principais. Amostre; não leia tudo.
3. Testes e CI: existem? cobrem o que importa?

**Avalie**
- Arquitetura: responsabilidades claras? acoplamento? onde vai doer ao crescer?
- Qualidade: tratamento de erro, validação nas bordas, tipagem, duplicação.
- Segurança: sinais óbvios (use a skill `auditoria-seguranca` para profundidade).
- Operação: config por ambiente, logs, build/deploy reproduzível.
- Desempenho: N+1, bundle grande, trabalho síncrono pesado.

**Formato**
```
NOTA GERAL: x/10 — uma frase
RISCOS (top 5): [ALTO|MÉDIO|BAIXO] descrição — evidência (arquivo:linha)
DÍVIDA TÉCNICA: itens curtos
PRÓXIMOS PASSOS: lista priorizada (o que fazer primeiro e por quê)
```
