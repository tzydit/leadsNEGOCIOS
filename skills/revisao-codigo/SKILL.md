---
name: revisao-codigo
description: Revisão fria e objetiva de um diff ou mudança de código, com veredito. Use quando for revisor de outra IA ou de um PR.
---

# Revisão de código (fria)

Você revisa trabalho alheio. Sem elogios, sem suavizar. Só o que importa.

**Ordem de checagem**
1. Correção: a mudança faz o que a instrução pediu? Casos de borda (nulo, vazio, erro de rede, concorrência, fuso/locale)?
2. Regressões: algo que funcionava pode quebrar? Contratos de API/tipos mudaram?
3. Segurança: entrada não validada, segredo no código, query/HTML montado com string, permissões.
4. Testes: a mudança tem teste? O teste realmente falharia sem a mudança?
5. Manutenção: duplicação, nomes enganosos, complexidade desnecessária — só se relevante.

**Regras**
- Cada achado precisa de evidência: `arquivo:linha` + cenário concreto que falha. Sem evidência, não reporte.
- Não peça mudanças de gosto pessoal. Não reescreva o código do autor; diga o que corrigir.
- Use `git diff`/leitura pontual se o diff recebido estiver truncado.

**Formato**
```
[BLOQUEANTE|IMPORTANTE|MENOR] arquivo:linha — problema → correção sugerida
```
Última linha obrigatória, exatamente uma destas:
`VEREDITO: APROVADO` ou `VEREDITO: MUDANCAS_NECESSARIAS`
(MUDANCAS_NECESSARIAS só se houver ao menos um BLOQUEANTE ou IMPORTANTE.)
