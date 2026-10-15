# 🏢 AI Office

Um escritório em pixel art onde o **Claude Code** e o **Codex** trabalham juntos no seu projeto.
Cada **sala** é uma **linha de trabalho**: você escreve o que cada IA deve fazer em cada etapa
(ex.: *linha 1: o Claude implementa, o Codex revisa*). Os avatares andam até a mesa, trabalham, e você acompanha ao vivo.

- **Linhas em paralelo**: cada linha roda no seu próprio `git worktree`, então as duas IAs trabalham ao mesmo tempo sem se atropelar.
- **Ciclo de revisão**: se o revisor responder `VEREDITO: MUDANCAS_NECESSARIAS`, o trabalho volta para quem executou junto com os apontamentos, até N rodadas.
- **Skills de desenvolvimento web e segurança** ativadas por etapa (economia de tokens, revisão fria, auditoria OWASP, análise do projeto…).
- **Economia de tokens**: a próxima IA recebe só o `RESUMO` da anterior e o diff (truncado), nunca a conversa inteira. Há orçamento de tokens por linha.
- **Comparativo Claude × Codex**: tokens por etapa, uso de cache, tempo, taxa de aprovação na revisão e custo.

### Como é a tela

- **Mapa** em pixel art ocupando a tela: o prédio fica num terreno com árvores, calçada e rua. Arraste para mover, use a roda do mouse (ou `+`/`−`) para zoom e o botão de enquadrar para ver o prédio inteiro.
- **Escritório** (à esquerda): busca (atalho `/`), filtro por IA e a lista de linhas, com o que cada IA está fazendo em cada etapa.
- **Atividade** (embaixo): o feed de tudo o que as IAs fazem, em todas as linhas. Clique para abrir a linha.
- **Detalhes** (à direita): etapas, log ao vivo, diff e tokens da linha selecionada. `Esc` fecha.
- No topo: contadores, o cartão de cada IA (modelo, raciocínio, tokens e custo do dia) e os custos ao vivo.

O visual foi inspirado no [Habblaud](https://github.com/marmottajr/habblaud) (MIT), outro escritório em pixel art para agentes do Claude Code e do Codex. A arte e o código daqui são próprios.

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

1. Em ⚙ **Configurações**, defina a **pasta padrão do projeto** (ou uma pasta por linha) com o botão **📁 Escolher**: navegue pelas suas pastas (repositórios git aparecem marcados) ou abra a janela de pastas do próprio Windows/macOS/Linux.
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

## Capturas de tela no Chrome (front-end)

Para design, a IA precisa **ver** a página. O AI Office tira capturas no **Google Chrome que você já tem instalado** (sem baixar navegador; se não houver Chrome, usa o Microsoft Edge):

1. Na linha, preencha **Site de preview** (ex.: `http://localhost:5173`) e, se quiser que o AI Office suba o site sozinho, o **Comando para subir o site** (ex.: `npm install && npm run dev`, que roda dentro do worktree da linha).
2. Marque a skill **📸 `captura-tela`** nas etapas de front-end, ou use o modelo **Front-end com capturas de tela** (Claude faz com `frontend-design` + `accessibility`, Codex revisa olhando as capturas).
3. Antes de cada etapa com a skill, o AI Office captura **desktop (1440×900)** e **celular (390×844)** e passa as imagens para a IA. No Claude, ela abre o PNG; no Codex, as imagens vão anexadas. O navegador também aponta erros de console, imagens que não carregaram e **rolagem horizontal** no celular.
4. Durante a etapa, a IA pode capturar de novo depois de ajustar (no máximo 3 rodadas, porque cada imagem custa cerca de 1,5 mil tokens).
5. Veja tudo na aba **📸 Capturas** da linha. O botão **Capturar agora** serve para testar.

Também dá para usar direto: `node scripts/screenshot.js http://localhost:5173 --name home --sizes desktop,tablet,mobile --full`. Se o Chrome estiver num lugar diferente, informe o caminho em ⚙ Configurações ou na variável `CHROME_PATH`.

Permissões: no Claude, só esse comando de captura é liberado (nada de `node` genérico). No Codex, o executor ganha acesso à rede local para abrir o site de preview; o revisor continua somente leitura e recebe as imagens anexadas.

## Modelos e raciocínio

- **No topo**, no cartão de cada IA, escolha o **modelo padrão** e o **nível de raciocínio** padrão. Vale para todas as etapas que não escolherem outro.
- **Em cada etapa**, dá para trocar o modelo e o raciocínio só daquela etapa (ex.: Opus para executar, Haiku para revisar).
- A lista do **Codex** vem do próprio CLI (`codex debug models`), com os níveis de raciocínio de cada modelo. A do **Claude** segue os modelos atuais. Use **Outro… (digitar)** para qualquer nome que o CLI aceite.
- Por baixo: Claude recebe `--model` e `--effort`; Codex recebe `-m` e `-c model_reasoning_effort=…`. O log **Ao vivo** mostra o modelo usado em cada etapa.
- Para o custo estimado ficar certo, o modelo escolhido precisa ter preço na tabela de ⚙ Configurações (senão vale `claude-padrao` / `codex-padrao`).

## Custos em tempo real

No topo do escritório: **agora** (o que as etapas em andamento já gastaram, subindo ao vivo), **hoje** e o gasto real das contas, se configurado. Cada sala mostra quanto a linha custou. Clique no painel de custos para ver o detalhe por dia.

- **Claude**: durante a etapa o valor é estimado pela tabela de preços; ao terminar, vale o custo exato informado pelo Claude Code.
- **Codex**: o CLI não informa preço, então vale a estimativa pela tabela de preços (aparece com `≈`).
- A tabela de preços (US$ por 1 milhão de tokens) fica em ⚙ Configurações. **Confira os valores**: os preços mudam e os do Codex dependem do modelo que você usa.
- Com assinatura (Claude Pro/Max, ChatGPT Plus/Pro), o valor mostrado é o **equivalente em API**; a cobrança real é a mensalidade.
- Etapas em modo simulado não entram nos totais.

### Gasto real das contas (opcional)

Se você usa as APIs pagas por uso numa **organização**, o AI Office lê o gasto real do mês e do dia nas APIs de custo da Anthropic e da OpenAI. Crie chaves de **administrador**, copie `.env.example` para `.env` e preencha:

```
ANTHROPIC_ADMIN_KEY=sk-ant-admin01-...   # Claude Console → Settings → Admin keys
OPENAI_ADMIN_KEY=sk-admin-...            # OpenAI Platform → Organization → Admin keys
```

Reinicie com `npm start`. As chaves ficam só no servidor local: não vão para o navegador nem para os processos do Claude e do Codex. Os dados chegam com alguns minutos de atraso, são atualizados a cada 5 minutos (configurável) e incluem **tudo** o que a organização gastou, não só o AI Office. Contas individuais e assinaturas não têm chave de administrador.

## Skills

São 16 skills no formato padrão `SKILL.md` (o mesmo do Claude Code e do Codex), agrupadas em **Front-end**, **Segurança** e **Geral**.

### ⭐ Melhores do GitHub

Escolhidas entre as fontes mais respeitadas e copiadas para [`skills/github/`](skills/github/) **só como texto** (sem scripts), revisadas, com a licença junto e fixadas no commit de origem (veja [`skills/catalog.json`](skills/catalog.json)). No site elas aparecem com ⭐.

| Skill | Categoria | Autor | Licença | Para quê |
|---|---|---|---|---|
| `frontend-design` | Front-end | Anthropic | Apache-2.0 | interfaces com identidade própria, sem cara de template |
| `vercel-react-best-practices` | Front-end | Vercel | MIT | mais de 60 regras de desempenho para React e Next.js |
| `accessibility` | Front-end | Addy Osmani | MIT | auditoria WCAG 2.2 |
| `core-web-vitals` | Front-end | Addy Osmani | MIT | LCP, INP e CLS |
| `performance` | Front-end | Addy Osmani | MIT | carregamento, bundle, imagens e cache |
| `security-best-practices` | Segurança | OpenAI | Apache-2.0 | guias por framework (React, Vue, Next.js, Express, Django, FastAPI, Flask, Go) |
| `security-threat-model` | Segurança | OpenAI | Apache-2.0 | modelagem de ameaças baseada no repositório |
| `differential-review` | Segurança | Trail of Bits | CC-BY-SA-4.0 | revisão de segurança de diffs |
| `sharp-edges` | Segurança | Trail of Bits | CC-BY-SA-4.0 | APIs e configurações perigosas |

Avaliadas e deixadas de fora: `web-design-guidelines` (Vercel) baixa as regras da internet a cada uso; `supply-chain-risk-auditor` (Trail of Bits), `webapp-testing` (Anthropic) e `playwright` (OpenAI) dependem de scripts; `insecure-defaults` (Trail of Bits) é um comando, não uma skill.

### Do AI Office

| Skill | Para quê |
|---|---|
| `economia-tokens` | ler pouco, editar cirurgicamente, responder curto, terminar com `RESUMO:` |
| `revisao-codigo` | revisão fria com evidência `arquivo:linha` e veredito |
| `auditoria-seguranca` | OWASP Top 10, segredos, auth, CSRF/SSRF, dependências, com veredito |
| `analise-fria` | nota, riscos, dívida técnica e próximos passos do projeto |
| `frontend-web` | acessibilidade, performance, responsividade, estado |
| `backend-api` | validação, autorização, banco, erros, idempotência |
| `testes-web` | testes que realmente falham sem a mudança, rodando só o necessário |
| 📸 `captura-tela` | captura a página no Chrome (desktop e celular) e confere o design pelas imagens |

Cada skill marcada numa etapa entra no prompt (o tamanho aproximado em tokens aparece ao passar o mouse). As skills grandes trazem arquivos de referência que a IA lê só quando precisa. O papel **Auditar segurança** já vem com `security-best-practices`.

Dentro do escritório, as skills marcadas vão **embutidas no prompt** da etapa. Para usá-las também no Claude Code e no Codex fora daqui:

```bash
npm run skills:global                            # as 16 skills em todas as sessões: ~/.claude/skills e ~/.codex/skills
npm run skills:install -- /caminho/do/projeto    # só um projeto: .claude/skills e .agents/skills
npm run skills:global -- --uninstall             # remove só o que o AI Office instalou
```

`CLAUDE_CONFIG_DIR` e `CODEX_HOME` são respeitados. Se você já tiver uma skill com o mesmo nome, ela **não** é sobrescrita (use `--force` se quiser). `--dry-run` mostra o que seria feito.

### Skills do GitHub para economizar tokens

Duas opções conhecidas e de licença aberta (Apache-2.0) que funcionam no Claude Code **e** no Codex. Elas não vêm embutidas aqui: revise e instale direto do projeto oficial.

| Projeto | O que economiza | Instalação global |
|---|---|---|
| [caveman](https://github.com/JuliusBrussee/caveman) | **Saída**: respostas curtas sem perder fatos técnicos. `caveman-compress` reescreve CLAUDE.md/AGENTS.md (lidos a cada turno) e corta **entrada**, mas envia o texto do arquivo ao provedor do modelo. | Claude: `claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman` · Codex: `npx skills add JuliusBrussee/caveman -a codex -g` (chame com `$caveman`) |
| [rtk](https://github.com/rtk-ai/rtk) | **Entrada**: comprime a saída de comandos do terminal (`git status`, testes, logs) antes de a IA ler. Não age em Read/Grep do Claude. | instale o binário (veja o README; `RTK_EDITION=oss` é a edição Apache-2.0) e rode `rtk init -g` (Claude) e `rtk init -g --codex` (Codex); confira com `rtk gain` |

Expectativa realista: o caveman anuncia de 65% a 75% menos tokens de saída por resposta, mas medições independentes apontam algo entre 12% e 24% na sessão inteira, porque a entrada (contexto) costuma pesar mais. Os maiores ganhos vêm de reduzir o que entra: menos etapas, arquivos de memória enxutos e saídas de comando comprimidas.

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
