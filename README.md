# 🏢 AI Office

Um escritório em pixel art onde o **Claude Code** e o **Codex** trabalham juntos no seu projeto.
Cada **sala** é uma **linha de trabalho**: você escreve o que cada IA deve fazer em cada etapa
(ex.: *linha 1: o Claude implementa, o Codex revisa*). Os avatares andam até a mesa, trabalham, e você acompanha ao vivo.

- **Linhas em paralelo**: cada linha roda no seu próprio `git worktree`, então as duas IAs trabalham ao mesmo tempo sem se atropelar.
- **Ciclo de revisão**: se o revisor responder `VEREDITO: MUDANCAS_NECESSARIAS`, o trabalho volta para quem executou junto com os apontamentos, até N rodadas.
- **Skills de desenvolvimento web e segurança** ativadas por etapa (economia de tokens, revisão fria, auditoria OWASP, análise do projeto…).
- **Economia de tokens**: a próxima IA recebe só o `RESUMO` da anterior e o diff (truncado), nunca a conversa inteira. Há orçamento de tokens por linha.
- **Comparativo Claude × Codex**: tokens por etapa, uso de cache, tempo, taxa de aprovação na revisão e custo.

## Como rodar

Requisitos: Node 20+, `git` e os CLIs que você já usa, autenticados:

```bash
npm i -g @anthropic-ai/claude-code   # depois: claude  (faça login)
npm i -g @openai/codex               # depois: codex login
```

```bash
npm install
npm start          # abre em http://localhost:4317
```

Sem os CLIs instalados, o escritório entra em **modo simulado** e funciona igual para você conhecer a interface. Nada é executado de verdade.
O modo de cada IA (auto, real ou simulado) fica em ⚙ Configurações.

## Usando

1. Em ⚙ **Configurações**, defina a **pasta padrão do projeto** (ou uma pasta por linha).
2. Escolha um modelo e clique em **+ Nova linha**, ou clique na sala vazia do escritório:
   - Claude faz → Codex revisa
   - Codex faz → Claude revisa
   - Claude planeja → Codex faz → Claude revisa
   - Auditoria de segurança cruzada
   - Análise fria do projeto
3. Na sala, ajuste as **etapas**: quem trabalha, o papel e **o que ele deve fazer**. Ligue ou desligue as skills.
4. Clique em **▶ Rodar linha**. Acompanhe em **Ao vivo**, veja o **Diff** e o consumo em **Tokens**.
5. Gostou do resultado? As mudanças ficam no branch `ai-office/<id-da-linha>`. Basta `git merge` no seu projeto.

| Papel | O que faz | Permissões |
|---|---|---|
| Executar | edita os arquivos | Claude: `acceptEdits` + comandos liberados · Codex: sandbox `workspace-write` |
| Revisar | revisa o diff da etapa anterior e dá veredito | somente leitura |
| Auditar segurança | procura vulnerabilidades exploráveis e dá veredito | somente leitura |
| Planejar | escreve um plano para a próxima IA | somente leitura |
| Análise fria | diagnóstico do projeto inteiro | somente leitura |

## Skills

Ficam em [`skills/`](skills/) no formato padrão `SKILL.md`, o mesmo usado pelo Claude Code e pelo Codex:

| Skill | Para quê |
|---|---|
| `economia-tokens` | ler pouco, editar cirurgicamente, responder curto, terminar com `RESUMO:` |
| `revisao-codigo` | revisão fria com evidência `arquivo:linha` e veredito |
| `auditoria-seguranca` | OWASP Top 10, segredos, auth, CSRF/SSRF, dependências |
| `analise-fria` | nota, riscos, dívida técnica e próximos passos do projeto |
| `frontend-web` | acessibilidade, performance, responsividade, estado |
| `backend-api` | validação, autorização, banco, erros, idempotência |
| `testes-web` | testes que realmente falham sem a mudança, rodando só o necessário |

Dentro do escritório, as skills marcadas vão **embutidas no prompt** da etapa. Para usá-las também no Claude Code e no Codex fora daqui:

```bash
npm run skills:install -- /caminho/do/projeto   # copia para .claude/skills e .agents/skills
```

## Dicas para gastar menos tokens

- Cada chamada do Claude Code já começa com cerca de 38 mil tokens de entrada (prompt do sistema e ferramentas), a maior parte vinda do cache. **Menos etapas = menos custo fixo.** Junte instruções pequenas numa etapa só.
- Se você tem muitos servidores MCP configurados, coloque `--strict-mcp-config` em *Argumentos extras* do Claude para não carregá-los nas etapas.
- Use modelos menores na revisão (campo **Modelo** da etapa) e reserve o maior para executar.
- Defina um **orçamento de tokens** na linha: ao estourar, a etapa é interrompida.
- Diminua *Máx. caracteres de diff* nas configurações. O revisor ainda pode rodar `git diff` em arquivos específicos se precisar.

## Segurança

O AI Office dispara IAs que editam código na sua máquina, então ele:

- escuta só em `127.0.0.1`;
- recusa requisições com `Host` diferente de localhost (proteção contra DNS rebinding);
- recusa chamadas de outras origens e corpos que não sejam JSON (proteção contra CSRF);
- passa o prompt sempre por `stdin` e nunca monta comandos de shell com o seu texto;
- roda revisores e auditores em modo somente leitura.

Não exponha a porta na rede.

## Estrutura

```
server/
  index.js          servidor HTTP + WebSocket
  orchestrator.js   roda as linhas: etapas, ciclo de revisão, orçamento, estatísticas
  prompts.js        monta o prompt de cada etapa (skills → papel → instrução → contexto)
  adapters/         claude (stream-json), codex (exec --json), simulado
  git.js            worktree e diff
public/             interface (canvas pixel art, sem build)
skills/             skills SKILL.md
test/               npm test
```

Estado e worktrees ficam em `data/` (fora do git).
