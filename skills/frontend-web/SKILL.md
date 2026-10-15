---
name: frontend-web
description: Boas práticas de frontend web — acessibilidade, performance, responsividade e estado. Use ao implementar ou revisar interfaces web (HTML/CSS/JS, React, Vue, Svelte, Next).
---

# Frontend web

**Ao implementar**
- HTML semântico (`button` para ação, `a` para navegação, `label` ligado ao input, um `h1`).
- Acessibilidade: foco visível, navegação por teclado, `alt` em imagens, contraste AA, `aria-*` só quando o HTML não basta.
- Responsivo mobile-first; sem largura fixa que gere scroll horizontal.
- Estado: fonte única da verdade; derive em vez de duplicar; trate loading, vazio e erro em toda busca de dados.
- Performance: imagens com dimensão e `loading="lazy"`, evite re-render desnecessário, divida bundles grandes, não bloqueie a main thread.
- Segurança: nunca injete HTML não sanitizado; não guarde token sensível em `localStorage` se puder usar cookie `HttpOnly`.
- Siga o padrão do projeto (framework, CSS, lint) — não introduza biblioteca nova sem necessidade.

**Ao revisar**: verifique os itens acima apenas no código alterado, com `arquivo:linha`.
