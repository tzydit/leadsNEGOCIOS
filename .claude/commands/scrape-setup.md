---
description: Sobe o motor local de extração do Google Maps no Docker e faz uma verificação de saúde.
---
Configure o motor do projeto neste computador:

1. Confirme que o Docker está instalado e rodando: `docker ps`. Se der erro, diga ao usuário para instalar ou abrir o **Docker Desktop** (link no `SETUP.md` §0) e pare aqui.
2. Na raiz do projeto, suba o motor: `docker compose up -d`.
3. Espere ~10s e confirme: `curl http://localhost:8080/api/v1/jobs` deve devolver JSON: `null` ou `[]` quando ainda não há jobs, senão a lista de jobs.
4. Informe o sucesso. Diga que agora dá para rodar `/scrape <negócio> em <cidade>`, ou pedir em linguagem natural (ex.: "busque academias em Curitiba").
5. **Mostre este aviso uma vez, quando a configuração der certo:**
   > **Antes de buscar:** o motor faz requisições reais ao Google Maps. Uso leve não tem problema. Jobs
   > grandes em sequência, `depth` alto, muitos termos ou execuções agendadas sem proxies podem fazer o
   > Google limitar seu IP temporariamente, geralmente por minutos ou horas. Sua conta Google não é
   > afetada. Rode um job por vez, comece com `depth 5` e use proxies para execuções grandes ou repetidas.
   > Extrair dados do Google Maps vai contra os Termos de Serviço do Google, e dados de contato são dados
   > pessoais, então siga a LGPD.

Se algum passo falhar, veja o `SETUP.md` §6 (Solução de problemas).
