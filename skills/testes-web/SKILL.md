---
name: testes-web
description: Escrever e rodar testes para projetos web (unitários, integração, e2e) de forma econômica. Use quando a tarefa pedir testes ou quando uma mudança precisar de cobertura.
---

# Testes web

- Descubra o framework existente (`package.json` scripts, `vitest`, `jest`, `pytest`, `playwright`) e use-o; não adicione outro.
- Teste comportamento, não implementação: entrada → saída/efeito observável.
- Para cada mudança: 1 caso feliz, os casos de borda relevantes e 1 caso de erro.
- O teste deve falhar sem a mudança — se não falharia, não está testando nada.
- Mock só na fronteira (rede, relógio, banco externo); prefira banco/servidor em memória quando houver.
- Rode só os testes afetados (`npx vitest run caminho`, `npx jest caminho`, `pytest caminho::teste`) e mostre só o resumo do resultado.
- Teste instável (flaky) é bug: corrija a causa (espera explícita, dado determinístico), não aumente o timeout.
