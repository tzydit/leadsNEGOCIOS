---
name: economia-tokens
description: Regras para gastar o mínimo de tokens em qualquer tarefa de código. Use sempre que trabalhar em uma linha do AI Office ou quando o usuário pedir economia de contexto.
---

# Economia de tokens

**Leitura**
- Localize antes de ler: `grep`/`glob` primeiro, depois leia só o trecho (offset/limit), nunca o arquivo inteiro sem motivo.
- Não releia arquivo que você acabou de editar; não abra lockfiles, `dist/`, `node_modules/`, imagens ou minificados.
- Pare de explorar assim que tiver o suficiente para agir.

**Escrita**
- Edições mínimas e cirúrgicas; não reformate o que não mudou.
- Não cole código de volta na resposta: cite `arquivo:linha`.
- Não explique o óbvio, não repita a instrução, não faça introdução nem despedida.

**Comandos**
- Rode o teste/lint mais específico possível (um arquivo, um pacote), não a suíte inteira, salvo se pedido.
- Limite saídas longas (`| tail -n 40`, `--silent`, `-q`).

**Resposta final**
- Termine com `RESUMO:` em no máximo 5 linhas (o que mudou, onde, o que falta). Esse resumo é o que a próxima IA recebe — seja preciso.
