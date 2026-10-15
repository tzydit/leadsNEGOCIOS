---
name: captura-tela
description: Tira capturas de tela do site no Chrome (desktop e celular) e usa as imagens para conferir e ajustar o design. Use em toda tarefa de front-end ou UI, antes de dar o trabalho por terminado, e ao revisar mudanças visuais.
---

# Captura de tela no Chrome

Design só está pronto depois que você **viu** a página. Código que "deveria" ficar bom não conta.

**Comando** (abre o Chrome em segundo plano, não precisa de internet):
```
{{CAPTURA_CMD}} <url> --name <nome-curto>
```
- Salva `desktop` (1440×900) e `mobile` (390×844) e lista os arquivos.
- Mostra erros de console, requisições que falharam e rolagem horizontal.
- Opções: `--sizes desktop,tablet,mobile` · `--full` (página inteira, até 6000px) · `--theme dark` · `--wait 1500` (animações).

**Ciclo (no máximo 3 rodadas; cada imagem custa ~1,5 mil tokens)**
1. Garanta que o site está no ar (a URL de preview vem no prompt; se não vier, suba o servidor de desenvolvimento em segundo plano e use a URL local).
2. Capture e **abra as imagens**: no Claude, leia o arquivo PNG com a ferramenta de leitura; no Codex, use `view_image` (ou veja as imagens anexadas).
3. Confira, nesta ordem: layout quebrado ou sobreposto · rolagem horizontal no celular · hierarquia e alinhamento · espaçamentos · contraste e legibilidade · fontes e imagens carregadas · estados vazio/erro/carregando · foco visível · erros de console.
4. Corrija o que viu e capture de novo **só as telas afetadas**.

**Revisores**: comparem as capturas com a instrução do usuário. Achado visual = arquivo da captura + elemento + o que está errado + correção.

**No RESUMO**: liste os arquivos das capturas finais e os problemas visuais que ficaram.

Se o comando falhar por falta de navegador ou por bloqueio de sandbox, diga isso em uma linha e siga sem capturas. Não instale nada.
