import { Office, STATUS_TEXT, activityIcon, lineStatus } from './office.js';
import { WORKER_STYLE, sprite } from './sprites.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};
const fmtMs = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const total = (u) => (u?.input ?? 0) + (u?.output ?? 0);
const fmtUsd = (v) => {
  v = Number(v) || 0;
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'agora' : s < 3600 ? `há ${Math.round(s / 60)} min` : `há ${Math.round(s / 3600)} h`;
};
const wname = (w) => WORKER_STYLE[w]?.name ?? w;

const S = {
  data: null,
  logs: new Map(),
  selected: null,
  tab: 'etapas',
  drafts: new Map(),
  saveTimers: new Map(),
  diff: null,
};

// ---- API / WebSocket ------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Erro ${res.status}`);
  return json;
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), 3200);
}

const safe = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    toast(e.message, true);
  }
};

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connect, 1500);
}

function handle(msg) {
  if (msg.type === 'state') {
    S.data = msg.state;
    S.data.running = new Set(msg.state.running);
    S.logs = new Map(S.data.lines.map((l) => [l.id, l.run?.log ?? []]));
    for (const l of S.data.lines) if (l.run) delete l.run.log;
    if (S.selected && !getLine(S.selected)) S.selected = null;
    for (const id of [...S.drafts.keys()]) if (!getLine(id)) S.drafts.delete(id);
    renderAll();
  } else if (msg.type === 'line') {
    const i = S.data.lines.findIndex((l) => l.id === msg.line.id);
    if (i < 0) return;
    const prevStatus = S.data.lines[i].run?.status;
    S.data.lines[i] = msg.line;
    if (msg.running) S.data.running = new Set(msg.running);
    if (msg.line.run?.status !== prevStatus && msg.line.run?.status === 'running') S.logs.set(msg.line.id, []);
    if (!isEditing(msg.line.id)) S.drafts.delete(msg.line.id);
    office.setData(S.data);
    renderWorkers();
    renderOffice();
    renderStats();
    if (S.selected === msg.line.id) renderPanel({ soft: true });
  } else if (msg.type === 'log') {
    const arr = S.logs.get(msg.lineId) ?? [];
    arr.push(msg.entry);
    if (arr.length > 400) arr.splice(0, arr.length - 400);
    S.logs.set(msg.lineId, arr);
    if (S.selected === msg.lineId && S.tab === 'vivo') appendLog(msg.entry);
    if (S.selected === msg.lineId && S.tab === 'capturas' && String(msg.entry.text).startsWith('📸')) renderCaptures($('.panel-body'), getLine(msg.lineId));
    scheduleFeed();
  } else if (msg.type === 'stats') {
    S.data.stats = msg.stats;
    if (msg.costDaily) S.data.costDaily = msg.costDaily;
    renderWorkers();
  } else if (msg.type === 'billing') {
    S.data.billing = msg.billing;
    renderCosts();
    if ($('#modal').open && $('#modalTitle').textContent === 'Custos') $('#modalBody').innerHTML = costsHtml();
  } else if (msg.type === 'running') {
    S.data.running = new Set(msg.running);
  }
}

const getLine = (id) => S.data?.lines.find((l) => l.id === id);
const isRunning = (id) => getLine(id)?.run?.status === 'running';
const isEditing = (id) => S.saveTimers.has(id) || (S.selected === id && $('#panel')?.contains(document.activeElement) && document.activeElement.matches('input,textarea,select'));

function draft(id) {
  if (!S.drafts.has(id)) S.drafts.set(id, structuredClone(getLine(id)));
  return S.drafts.get(id);
}

function scheduleSave(id) {
  clearTimeout(S.saveTimers.get(id));
  S.saveTimers.set(
    id,
    setTimeout(
      safe(async () => {
        S.saveTimers.delete(id);
        const d = S.drafts.get(id);
        if (!d) return;
        const { name, workdir, useWorktree, tokenBudget, loop, steps, preview } = d;
        await api('PUT', `/api/lines/${id}`, { name, workdir, useWorktree, tokenBudget, loop, steps, preview });
      }),
      450,
    ),
  );
}

async function flushSave(id) {
  if (!S.saveTimers.has(id)) return;
  clearTimeout(S.saveTimers.get(id));
  S.saveTimers.delete(id);
  const d = S.drafts.get(id);
  const { name, workdir, useWorktree, tokenBudget, loop, steps, preview } = d;
  await api('PUT', `/api/lines/${id}`, { name, workdir, useWorktree, tokenBudget, loop, steps, preview });
}

// ---- top bar --------------------------------------------------------------

function renderWorkers() {
  const box = $('#workers');
  for (const [w, info] of Object.entries(S.data.workers)) {
    let chip = box.querySelector(`[data-chip="${w}"]`);
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'worker-chip';
      chip.dataset.chip = w;
      chip.style.setProperty('--wc', WORKER_STYLE[w].color);
      chip.innerHTML = `
        <span class="acct-badge" aria-hidden="true">${WORKER_STYLE[w].letter}</span>
        <div>
          <div class="wname">${esc(wname(w))} <span class="mode"></span></div>
          <div class="wpick">
            <select data-chip-model="${w}" aria-label="Modelo padrão do ${esc(wname(w))}"></select>
            <select data-chip-effort="${w}" aria-label="Raciocínio padrão do ${esc(wname(w))}"></select>
          </div>
          <div class="wmeta"></div>
        </div>`;
      box.append(chip);
    }
    const st = S.data.stats[w];
    const busy = S.data.lines.filter((l) => l.run?.status === 'running' && l.run.attempts.at(-1)?.worker === w).length;
    const mode = chip.querySelector('.mode');
    mode.className = `mode ${info.mode}`;
    mode.textContent = info.mode;
    mode.title = info.mode === 'simulado' ? 'CLI não encontrado ou modo simulado: nada é executado de verdade' : 'Executando o CLI de verdade';
    const meta = chip.querySelector('.wmeta');
    meta.title = busy ? `trabalhando em ${busy} sala(s)` : 'na copa';
    meta.textContent = `${busy ? `▶ ${busy} sala${busy > 1 ? 's' : ''}` : 'na copa'} · ${fmt(st.input + st.output + runningAttempts(w).reduce((a, r) => a + total(r.a.usage), 0))} tokens · hoje ${fmtUsd(todayCost(w))}`;
    // Recria as opções só quando mudam e o usuário não está mexendo nelas.
    const cfg = S.data.settings.workers[w];
    const ms = chip.querySelector('[data-chip-model]');
    const es = chip.querySelector('[data-chip-effort]');
    const sig = JSON.stringify([cfg.model, cfg.effort, S.data.models?.[w]?.models?.length]);
    if (ms.dataset.sig !== sig && document.activeElement !== ms && document.activeElement !== es) {
      ms.innerHTML = modelOptions(w, cfg.model, 'Modelo padrão');
      es.innerHTML = effortOptions(w, cfg.model, cfg.effort, 'Raciocínio');
      ms.dataset.sig = sig;
      ms.dataset.prev = cfg.model;
      ms.title = modelInfo(w, cfg.model)?.description || 'Modelo usado quando a etapa não escolhe outro';
    }
  }
  renderCosts();
}

// ---- painel ---------------------------------------------------------------

function renderAll() {
  office.setData(S.data);
  office.setSelected(S.selected);
  renderWorkers();
  renderStats();
  renderOffice();
  renderFeed();
  renderPanel();
}

function renderPanel({ soft = false } = {}) {
  const panel = $('#panel');
  const line = getLine(S.selected);
  const open = Boolean(line);
  if (panel.hidden === open || document.body.classList.contains('right-open') !== open) {
    panel.hidden = !open;
    document.body.classList.toggle('right-open', open);
    updateInsets();
  }
  if (!line) {
    panel.innerHTML = '';
    return;
  }
  // Atualização vinda do servidor enquanto o usuário digita: só o cabeçalho.
  if (soft && S.tab === 'etapas' && isEditing(line.id)) {
    renderHead(line);
    return;
  }
  const keepScroll = soft ? $('.panel-body', panel)?.scrollTop : 0;
  panel.innerHTML = `<div class="panel-head"></div>
    <div class="tabs" role="tablist">
      ${[['etapas', 'Etapas', line.steps.length], ['vivo', 'Ao vivo', ''], ['capturas', '📸 Capturas', ''], ['diff', 'Diff', ''], ['tokens', 'Tokens', fmt(lineTokens(line))]]
        .map(([k, label, c]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${label}${c !== '' ? `<span class="count">${c}</span>` : ''}</button>`)
        .join('')}
    </div>
    <div class="panel-body"></div>`;
  renderHead(line);
  const body = $('.panel-body', panel);
  if (S.tab === 'etapas') body.innerHTML = stepsHtml(line);
  if (S.tab === 'vivo') renderLog(body, line);
  if (S.tab === 'diff') renderDiff(body, line, soft);
  if (S.tab === 'tokens') body.innerHTML = tokensHtml(line);
  if (S.tab === 'capturas') renderCaptures(body, line, soft);
  if (soft && S.tab !== 'vivo') body.scrollTop = keepScroll;
}

function renderHead(line) {
  const head = $('.panel-head');
  if (!head) return;
  const st = lineStatus(line);
  const [label] = STATUS_TEXT[st];
  const running = line.run?.status === 'running';
  const cur = line.run?.attempts?.at(-1);
  const d = S.drafts.get(line.id) ?? line;
  const focusedName = document.activeElement?.id === 'lineName';
  if (focusedName) {
    $('.status', head).className = `status ${st}`;
    $('.status', head).textContent = label;
    return;
  }
  head.innerHTML = `
    <div class="panel-title">
      <input id="lineName" type="text" value="${esc(d.name)}" aria-label="Nome da linha" ${running ? 'disabled' : ''}>
      <span class="status ${st === 'running' ? 'running' : st}">${label}</span>
      <button class="icon-btn small" data-act="close" aria-label="Fechar painel" title="Fechar"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>
    </div>
    <div class="run-row">
      ${running
        ? `<button class="btn stop" data-act="stop">■ Parar</button>`
        : `<button class="btn go" data-act="run">▶ Rodar linha</button>`}
      <span class="grow">${running && cur ? `${esc(wname(cur.worker))} · etapa ${cur.step + 1} · ${esc(cur.activity || '')}` : line.run?.endedAt ? `Última execução: ${new Date(line.run.endedAt).toLocaleString('pt-BR')}` : 'Ainda não rodou'}</span>
      <button class="btn ghost small" data-act="delete" ${running ? 'disabled' : ''} title="Remover linha">Remover</button>
    </div>`;
}

function welcomeHtml() {
  const sim = Object.entries(S.data.workers).filter(([, i]) => i.mode === 'simulado').map(([w]) => wname(w));
  return `<div class="onboard">
    <h3>Bem-vindo ao escritório</h3>
    ${sim.length ? `<div class="notice">${esc(sim.join(' e '))} em <b>modo simulado</b>: o CLI não foi encontrado (ou foi forçado nas configurações). Dá para testar tudo; nada é executado de verdade.</div>` : ''}
    <ol>
      <li>Cada <b>sala</b> é uma <b>linha de trabalho</b>. Crie uma com <b>+ Nova linha</b> (escolha um modelo) ou clicando na sala vazia.</li>
      <li>Em cada <b>etapa</b>, escolha quem trabalha (Claude ou Codex), o papel (executar, revisar, auditar…) e escreva <b>o que ele deve fazer</b>.</li>
      <li>Com <b>Ciclo de revisão</b> ligado, se o revisor pedir mudanças o trabalho volta para quem executou.</li>
      <li>Linhas diferentes rodam <b>ao mesmo tempo</b>, cada uma no seu git worktree.</li>
      <li>As <b>skills</b> (economia de tokens, revisão, segurança…) ficam na Biblioteca e são ativadas por etapa.</li>
    </ol>
    <p>Defina a pasta padrão do projeto em ⚙ Configurações ou em cada linha.</p>
  </div>`;
}

function stepsHtml(line) {
  const d = S.drafts.get(line.id) ?? line;
  const running = line.run?.status === 'running';
  const run = line.run;
  const notices = [];
  if (run?.error) notices.push(`<div class="notice err">${esc(run.error)}</div>`);
  else if (run?.notice) notices.push(`<div class="notice">${esc(run.notice)}</div>`);
  if (running) notices.push('<div class="notice">A linha está rodando: a edição fica bloqueada até ela terminar ou você parar.</div>');
  const stepsHtml = d.steps
    .map((s, i) => {
      const last = run?.attempts?.filter((a) => a.step === i).at(-1);
      const next = d.steps[i + 1];
      const loopHere = d.loop?.enabled && next && (next.role === 'revisar' || next.role === 'auditar');
      return stepCard(s, i, d.steps.length, last) + (next ? `<div class="step-connector${loopHere ? ' loop' : ''}"></div>` : '');
    })
    .join('');
  return `${notices.join('')}
  <fieldset ${running ? 'disabled' : ''} style="border:0;padding:0;margin:0;min-width:0">
    <div class="grid">
      <div class="field full">
        <label for="fWorkdir">Pasta do projeto</label>
        <div class="with-btn">
          <input id="fWorkdir" type="text" data-f="workdir" value="${esc(d.workdir)}" placeholder="${esc(S.data.settings.defaultWorkdir || 'escolha a pasta do projeto')}">
          <button class="btn small" type="button" data-act="pick-workdir">📁 Escolher</button>
        </div>
      </div>
      <label class="check"><input type="checkbox" data-f="useWorktree" ${d.useWorktree ? 'checked' : ''}> Worktree isolado (git)</label>
      <div class="field">
        <label for="fBudget">Orçamento de tokens (0 = sem limite)</label>
        <input id="fBudget" type="number" min="0" step="10000" data-f="tokenBudget" value="${d.tokenBudget || 0}">
      </div>
      <label class="check inline"><input type="checkbox" data-f="loop.enabled" ${d.loop?.enabled ? 'checked' : ''}> Ciclo de revisão, até
        <input type="number" min="1" max="5" data-f="loop.maxRounds" value="${d.loop?.maxRounds ?? 2}" aria-label="Máximo de rodadas"> rodadas</label>
      <div class="field">
        <label for="fPreview">Site de preview (para capturas no Chrome)</label>
        <input id="fPreview" type="text" data-f="preview.url" value="${esc(d.preview?.url ?? '')}" placeholder="http://localhost:5173">
      </div>
      <div class="field">
        <label for="fPreviewCmd">Comando para subir o site (opcional)</label>
        <input id="fPreviewCmd" type="text" data-f="preview.command" value="${esc(d.preview?.command ?? '')}" placeholder="npm install && npm run dev">
      </div>
    </div>
    <div class="section-title">
      <span>ETAPAS</span>
      <select data-act="template" aria-label="Aplicar modelo">
        <option value="">Aplicar modelo…</option>
        ${Object.entries(S.data.templates).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}
      </select>
    </div>
    <div class="steps">${stepsHtml || '<div class="empty">Nenhuma etapa. Adicione abaixo.</div>'}</div>
    <div class="add-step">
      <button class="btn" data-act="add" data-worker="claude" ${d.steps.length >= S.data.maxSteps ? 'disabled' : ''}>+ Etapa do Claude</button>
      <button class="btn" data-act="add" data-worker="codex" ${d.steps.length >= S.data.maxSteps ? 'disabled' : ''}>+ Etapa do Codex</button>
    </div>
  </fieldset>`;
}

const ROLE_HINT = {
  executar: 'o que ele deve fazer',
  revisar: 'o que ele deve conferir na revisão',
  auditar: 'o foco da auditoria de segurança',
  planejar: 'o que ele deve planejar',
  analisar: 'o que ele deve analisar',
};

function stepCard(s, i, n, last) {
  const color = WORKER_STYLE[s.worker].color;
  const meta = last
    ? `<div class="step-meta"><span>${esc(last.status === 'running' ? `▶ ${last.activity || 'trabalhando'}` : last.status)}</span><span>${fmt(total(last.usage))} tokens</span>${last.verdict ? `<span class="verdict ${last.verdict}">${last.verdict}</span>` : ''}${last.round > 1 ? `<span>rodada ${last.round}</span>` : ''}</div>`
    : '';
  return `<div class="step${last?.status === 'running' ? ' running' : ''}" style="--wc:${color}" data-i="${i}">
    <div class="step-head">
      <span class="step-num">${i + 1}</span>
      <select data-s="worker" aria-label="Trabalhador">
        ${Object.keys(WORKER_STYLE).map((w) => `<option value="${w}" ${w === s.worker ? 'selected' : ''}>${wname(w)}</option>`).join('')}
      </select>
      <select data-s="role" aria-label="Papel">
        ${Object.entries(S.data.roles).map(([k, r]) => `<option value="${k}" ${k === s.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
      </select>
      <span class="tools">
        <button class="btn ghost small" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Subir etapa">↑</button>
        <button class="btn ghost small" data-act="down" ${i === n - 1 ? 'disabled' : ''} aria-label="Descer etapa">↓</button>
        <button class="btn ghost small" data-act="remove" aria-label="Remover etapa">✕</button>
      </span>
    </div>
    <label for="ins-${i}">${esc(wname(s.worker))}: ${ROLE_HINT[s.role] ?? 'instrução'}</label>
    <textarea id="ins-${i}" data-s="instruction" rows="3" placeholder="Ex.: Crie a página de login com validação no backend…">${esc(s.instruction)}</textarea>
    <div class="skills">
      ${skillChips(s)}
    </div>
    ${modelLine(s)}
    ${meta}
  </div>`;
}

// ---- ao vivo --------------------------------------------------------------

const KIND_ICON = { info: '·', text: '❝', tool: '⌕', command: '$', file: '✎', thinking: '…', error: '✖', done: '✔' };

function logEntryHtml(e) {
  const color = e.worker ? WORKER_STYLE[e.worker]?.color : 'var(--line)';
  const time = new Date(e.t).toLocaleTimeString('pt-BR', { hour12: false });
  return `<div class="log-entry ${esc(e.kind)}" style="--wc:${color}"><time>${time}</time><span class="ic">${KIND_ICON[e.kind] ?? '·'}</span><span class="tx">${esc(e.text)}</span></div>`;
}

function renderLog(body, line) {
  const logs = S.logs.get(line.id) ?? [];
  body.innerHTML = logs.length ? `<div class="log">${logs.map(logEntryHtml).join('')}</div>` : '<div class="empty">Sem atividade ainda. Rode a linha para ver o trabalho ao vivo.</div>';
  body.scrollTop = body.scrollHeight;
}

function appendLog(entry) {
  const body = $('.panel-body');
  if (!body) return;
  let log = $('.log', body);
  if (!log) {
    body.innerHTML = '<div class="log"></div>';
    log = $('.log', body);
  }
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  log.insertAdjacentHTML('beforeend', logEntryHtml(entry));
  if (log.children.length > 400) log.firstElementChild.remove();
  if (stick) body.scrollTop = body.scrollHeight;
}

// ---- diff -----------------------------------------------------------------

async function renderDiff(body, line, soft) {
  if (soft && S.diff?.lineId === line.id) return paintDiff(body, line);
  body.innerHTML = '<div class="empty">Carregando diff…</div>';
  try {
    S.diff = { lineId: line.id, ...(await api('GET', `/api/lines/${line.id}/diff`)) };
  } catch (e) {
    S.diff = { lineId: line.id, empty: true, message: e.message };
  }
  if (S.selected === line.id && S.tab === 'diff') paintDiff($('.panel-body'), line);
}

function paintDiff(body, line) {
  const d = S.diff;
  const project = line.workdir || S.data.settings.defaultWorkdir;
  const head = `<div class="section-title"><span>MUDANÇAS DA LINHA</span><button class="btn small" data-act="refresh-diff">Atualizar</button></div>
    ${d.branch ? `<label>As mudanças estão no branch <b>${esc(d.branch)}</b>. Para trazer para o projeto quando aprovar:</label><code class="code-hint">cd ${esc(project)} &amp;&amp; git merge ${esc(d.branch)}</code>` : ''}`;
  if (d.empty) {
    body.innerHTML = `${head}<div class="empty">${esc(d.message || 'Nenhuma mudança.')}</div>`;
    return;
  }
  const lines = String(d.diff)
    .split('\n')
    .map((l) => {
      const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'meta' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
      return `<span class="${cls}">${esc(l)}</span>`;
    })
    .join('\n');
  body.innerHTML = `${head}<pre class="diff" style="margin-bottom:8px">${esc(d.stat)}</pre><pre class="diff">${lines}</pre>${d.truncated ? '<div class="empty">Diff truncado.</div>' : ''}`;
}

// ---- capturas -------------------------------------------------------------

async function renderCaptures(body, line, soft = false) {
  if (!body || !line) return;
  if (!(soft && S.captures?.lineId === line.id)) {
    try {
      S.captures = { lineId: line.id, list: await api('GET', `/api/lines/${line.id}/captures`) };
    } catch (e) {
      S.captures = { lineId: line.id, list: [], error: e.message };
    }
  }
  if (S.selected !== line.id || S.tab !== 'capturas') return;
  const list = S.captures.list ?? [];
  const url = line.preview?.url;
  const problems = S.captureProblems?.length ? `<div class="notice">${S.captureProblems.map(esc).join('<br>')}</div>` : '';
  const groups = new Map();
  for (const c of list) {
    const key = c.file.replace(/-(desktop|tablet|mobile)\.png$/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const label = (k) => (k.startsWith('manual') ? 'Captura manual' : k.replace(/^etapa(\d+)-r(\d+)$/, 'Antes da etapa $1 · rodada $2'));
  body.innerHTML = `<div class="section-title"><span>CAPTURAS NO CHROME</span><button class="btn small" data-act="capture-now" ${url ? '' : 'disabled'}>📸 Capturar agora</button></div>
    <p class="compare-note" style="margin-top:0">${url ? `Preview: <code>${esc(url)}</code>. ` : 'Defina o <b>site de preview</b> na aba Etapas. '}Etapas com a skill <code>captura-tela</code> capturam desktop e celular antes de começar, e a IA pode capturar de novo enquanto ajusta o design.</p>
    ${problems}
    ${list.length ? [...groups].map(([k, items]) => `<div class="shot-group"><h4>${esc(label(k))} <small>${new Date(items[0].t).toLocaleTimeString('pt-BR', { hour12: false })}</small></h4><div class="shots">${items
      .sort((a, b) => a.file.localeCompare(b.file))
      .map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener" class="shot"><img src="${esc(c.url)}" alt="${esc(c.file)}" loading="lazy"><span>${esc(c.file.match(/-(desktop|tablet|mobile)\.png$/)?.[1] ?? c.file)}</span></a>`)
      .join('')}</div></div>`).join('') : '<div class="empty">Nenhuma captura ainda.</div>'}`;
}

// ---- tokens ---------------------------------------------------------------

function lineTokens(line) {
  return (line.run?.attempts ?? []).reduce((a, t) => a + total(t.usage), 0);
}

function tokensHtml(line) {
  const at = line.run?.attempts ?? [];
  if (!at.length) return '<div class="empty">Rode a linha para ver o consumo de cada etapa.</div>';
  const sum = at.reduce((a, t) => ({ input: a.input + t.usage.input, cachedInput: a.cachedInput + t.usage.cachedInput, output: a.output + t.usage.output, costUsd: a.costUsd + (t.cost || 0), exact: a.exact && (t.costExact || !t.cost), ms: a.ms + ((t.endedAt || Date.now()) - t.startedAt) }), { input: 0, cachedInput: 0, output: 0, costUsd: 0, exact: true, ms: 0 });
  const cachePct = sum.input ? Math.round((sum.cachedInput / sum.input) * 100) : 0;
  const budget = line.tokenBudget ? `<p class="compare-note">Orçamento: ${fmt(total(sum))} de ${fmt(line.tokenBudget)} tokens (${Math.round((total(sum) / line.tokenBudget) * 100)}%).</p>` : '';
  return `<table>
    <thead><tr><th>Etapa</th><th>IA · papel</th><th>Entrada</th><th>Cache</th><th>Saída</th><th>Custo</th><th>Tempo</th></tr></thead>
    <tbody>${at
      .map(
        (t) => `<tr>
        <td>${t.step + 1}${t.round > 1 ? `<small> r${t.round}</small>` : ''}</td>
        <td><span class="dot" style="--wc:${WORKER_STYLE[t.worker].color}"></span>${esc(wname(t.worker))} · ${esc(S.data.roles[t.role]?.label ?? t.role)}${t.verdict ? ` <span class="verdict ${t.verdict}">${t.verdict === 'APROVADO' ? '✔' : '⚠'}</span>` : ''}${t.mode === 'simulado' ? ' <small>(sim)</small>' : ''}</td>
        <td>${fmt(t.usage.input)}</td><td>${fmt(t.usage.cachedInput)}</td><td>${fmt(t.usage.output)}</td>
        <td title="${t.costExact ? 'custo informado pelo CLI' : `estimativa pela tabela de preços (${esc(t.usage.model || 'modelo padrão')})`}">${t.cost ? `${t.costExact ? '' : '≈'}${fmtUsd(t.cost)}` : '—'}</td>
        <td>${fmtMs((t.endedAt || Date.now()) - t.startedAt)}</td></tr>`,
      )
      .join('')}</tbody>
    <tfoot><tr><td colspan="2">Total</td><td>${fmt(sum.input)}</td><td>${fmt(sum.cachedInput)}</td><td>${fmt(sum.output)}</td><td>${sum.costUsd ? `${sum.exact ? '' : '≈'}${fmtUsd(sum.costUsd)}` : '—'}</td><td>${fmtMs(sum.ms)}</td></tr></tfoot>
  </table>
  <p class="compare-note">${cachePct}% da entrada veio do cache (mais barato). Custo com ≈ é estimativa pela tabela de preços (⚙ Configurações); sem ≈ é o valor informado pelo Claude. Etapas simuladas não entram nos totais do dia.</p>${budget}`;
}

// ---- modais ---------------------------------------------------------------

function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  const m = $('#modal');
  if (!m.open) m.showModal();
}

function compareHtml() {
  const st = S.data.stats;
  const workers = Object.keys(WORKER_STYLE);
  const per = (w, f) => {
    const s = st[w];
    return f(s);
  };
  const metrics = [
    ['Etapas feitas', (s) => s.steps, (v) => String(v)],
    ['Tokens por etapa', (s) => (s.steps ? (s.input + s.output) / s.steps : 0), fmt],
    ['Saída por etapa', (s) => (s.steps ? s.output / s.steps : 0), fmt],
    ['Entrada do cache', (s) => (s.input ? (s.cachedInput / s.input) * 100 : 0), (v) => `${Math.round(v)}%`],
    ['Tempo por etapa', (s) => (s.steps ? s.ms / s.steps : 0), fmtMs],
    ['Aprovação na revisão*', (s) => (s.aprovadas + s.reprovadas ? (s.aprovadas / (s.aprovadas + s.reprovadas)) * 100 : 0), (v) => `${Math.round(v)}%`],
    ['Revisões feitas', (s) => s.revisoes, (v) => String(v)],
    ['Falhas', (s) => s.falhas, (v) => String(v)],
    ['Custo total', (s) => s.costUsd, (v) => (v ? fmtUsd(v) : '—')],
  ];
  const rows = metrics
    .map(([label, f, show]) => {
      const vals = workers.map((w) => per(w, f));
      const max = Math.max(...vals, 0.0001);
      return `<div class="metric"><span class="mlabel">${label}</span>${workers
        .map((w, i) => `<div class="bar" style="--wc:${WORKER_STYLE[w].color}"><span class="fill" style="width:${Math.round((vals[i] / max) * 70)}%"></span><span class="val">${esc(wname(w))}: ${show(vals[i])}</span></div>`)
        .join('')}</div>`;
    })
    .join('');
  return `<div class="compare">${rows}</div>
    <p class="compare-note">* Do trabalho que cada IA executou e passou por uma etapa "Revisar", quanto foi aprovado pelo revisor (cada rodada conta). Números acumulados de todas as linhas (inclusive simuladas).</p>
    <button class="btn small" data-act="reset-stats">Zerar comparativo</button>`;
}

function settingsHtml() {
  const s = S.data.settings;
  const w = S.data.workers;
  const workerForm = (k) => {
    const c = s.workers[k];
    const info = w[k];
    return `<h3>${esc(wname(k))} — ${info.available ? `encontrado (${esc(info.version)})` : 'CLI não encontrado'}</h3>
      <div class="grid">
        <div class="field"><label>Modo</label><select name="${k}.mode">
          ${['auto', 'real', 'simulado'].map((m) => `<option value="${m}" ${c.mode === m ? 'selected' : ''}>${m === 'auto' ? 'auto (real se instalado)' : m}</option>`).join('')}
        </select></div>
        <div class="field"><label>Comando</label><input type="text" name="${k}.bin" value="${esc(c.bin)}"></div>
        <div class="field"><label>Modelo padrão</label><select name="${k}.model" data-prev="${esc(c.model)}">${modelOptions(k, c.model, 'Padrão do CLI')}</select></div>
        <div class="field"><label>Raciocínio padrão</label><select name="${k}.effort">${effortOptions(k, c.model, c.effort, 'Padrão do modelo')}</select></div>
        <div class="field"><label>Argumentos extras</label><input type="text" name="${k}.extraArgs" value="${esc(c.extraArgs)}"></div>
        ${k === 'claude'
          ? `<div class="field full"><label>Comandos liberados ao executar (allowedTools)</label><input type="text" name="claude.allowedTools" value="${esc(c.allowedTools)}"></div>
             <div class="field"><label>Limite em US$ por etapa (0 = sem)</label><input type="number" min="0" step="0.5" name="claude.maxBudgetUsd" value="${c.maxBudgetUsd || 0}"></div>`
          : ''}
      </div>`;
  };
  return `<form id="settingsForm">
    <h3>Projeto</h3>
    <div class="grid">
      <div class="field full"><label>Pasta padrão do projeto</label><div class="with-btn"><input type="text" name="defaultWorkdir" value="${esc(s.defaultWorkdir)}" placeholder="escolha a pasta do projeto"><button class="btn small" type="button" data-act="pick-default">📁 Escolher</button></div></div>
      <div class="field full"><label>Chrome para capturas (vazio = Google Chrome instalado, depois Edge)</label><input type="text" name="chromePath" value="${esc(s.chromePath ?? '')}" placeholder="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"></div>
      <div class="field"><label>Máx. caracteres de diff para o revisor</label><input type="number" min="1000" step="1000" name="diffMaxChars" value="${s.diffMaxChars}"></div>
      <div class="field"><label>Máx. caracteres do resumo repassado</label><input type="number" min="200" step="100" name="handoffMaxChars" value="${s.handoffMaxChars}"></div>
    </div>
    ${workerForm('claude')}${workerForm('codex')}
    <h3>Preços (US$ por 1 milhão de tokens)</h3>
    <p class="compare-note">Usados para o custo ao vivo. O Claude informa o custo exato ao fim de cada etapa; o Codex não, então vale a estimativa. Confira os preços atuais nas páginas da Anthropic e da OpenAI. As linhas <code>claude-padrao</code> e <code>codex-padrao</code> valem quando o modelo não é reconhecido.</p>
    <table class="pricing">
      <thead><tr><th>Modelo</th><th>Entrada</th><th>Cache lido</th><th>Cache gravado</th><th>Saída</th><th></th></tr></thead>
      <tbody id="pricingRows">${Object.entries(s.pricing ?? {}).map(([name, p], i) => pricingRow(i, name, p)).join('')}</tbody>
    </table>
    <button class="btn small" type="button" data-act="add-price">+ modelo</button>
    <div class="grid" style="margin-top:12px">
      <div class="field"><label>Atualizar gasto das contas a cada (segundos)</label><input type="number" min="60" step="60" name="billingPollSeconds" value="${s.billingPollSeconds ?? 300}"></div>
    </div>
    <p class="compare-note">Revisores e auditores rodam em modo somente leitura (Claude com ferramentas de leitura; Codex com sandbox read-only). Executores podem editar arquivos da pasta.</p>
    <div class="run-row"><button class="btn primary" type="submit">Salvar</button><button class="btn" type="button" data-act="detect">Detectar CLIs de novo</button></div>
  </form>`;
}

const CATEGORIAS = [
  ['frontend', 'Front-end'],
  ['seguranca', 'Segurança'],
  ['geral', 'Geral'],
];

/** Chips de skills da etapa, agrupados por categoria, com as melhores primeiro. */
function skillChips(step) {
  return CATEGORIAS.map(([cat, label]) => {
    const list = S.data.skills.filter((k) => k.categoria === cat);
    if (!list.length) return '';
    const chips = list
      .map((k) => {
        const tip = `${k.melhor ? `⭐ Melhor do GitHub · ${k.autor} · ${k.licenca}\n` : 'Skill do AI Office\n'}${k.porque || k.description}\n~${fmt(k.tokens)} tokens no prompt`;
        return `<button type="button" class="skill-chip${k.melhor ? ' best' : ''}${k.recomendada ? ' rec' : ''}" data-skill="${esc(k.name)}" aria-pressed="${step.skills.includes(k.name)}" title="${esc(tip)}">${k.melhor ? '⭐ ' : k.recomendada ? '📸 ' : ''}${esc(k.name)}</button>`;
      })
      .join('');
    return `<div class="skill-group"><span class="skill-cat">${label}</span>${chips}</div>`;
  }).join('');
}

function skillCard(k) {
  const head = k.melhor
    ? `<span class="best-badge">⭐ Melhor do GitHub</span><span class="skill-src">${esc(k.autor)} · ${esc(k.licenca)}${k.url ? ` · <a href="${esc(k.url)}" target="_blank" rel="noopener noreferrer">ver origem</a>` : ''}</span>`
    : `<span class="skill-src">AI Office · escrita para este projeto</span>`;
  return `<details class="skill-card${k.melhor ? ' best' : ''}" data-skill-card="${esc(k.name)}">
    <summary><b>${esc(k.name)}</b>${head}</summary>
    ${k.porque ? `<p class="skill-why">${esc(k.porque)}</p>` : ''}
    <p>${esc(k.description)}</p>
    <p class="skill-meta">~${fmt(k.tokens)} tokens no prompt${k.hasFiles ? ' · traz arquivos de referência (lidos só quando precisa)' : ''}</p>
    <pre>carregando…</pre>
  </details>`;
}

function skillsHtml() {
  const best = S.data.skills.filter((k) => k.melhor);
  const own = S.data.skills.filter((k) => !k.melhor);
  const section = (title, list) => (list.length ? `<h3>${title}</h3>${list.map(skillCard).join('')}` : '');
  const fora = (S.data.skillsFora ?? []).map((f) => `<li><b>${esc(f.nome)}</b>: ${esc(f.motivo)}</li>`).join('');
  return `<p class="compare-note" style="margin-top:0">Ative as skills em cada etapa da linha; elas entram no prompt daquela etapa. As marcadas com ⭐ são as mais respeitadas do GitHub para front-end e segurança, copiadas aqui só como texto (sem scripts), com licença e o commit exato de origem. Para usar todas no Claude Code e no Codex em qualquer sessão: <code>npm run skills:global</code>.</p>
    ${section('⭐ Melhores do GitHub — Front-end', best.filter((k) => k.categoria === 'frontend'))}
    ${section('⭐ Melhores do GitHub — Segurança', best.filter((k) => k.categoria === 'seguranca'))}
    ${section('Do AI Office', own)}
    ${fora ? `<h3>Avaliadas e deixadas de fora</h3><ul class="compare-note">${fora}</ul>` : ''}`;
}

// ---- eventos --------------------------------------------------------------

function mutate(id, fn) {
  const d = draft(id);
  fn(d);
  scheduleSave(id);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

function wirePanel() {
  const panel = $('#panel');
  panel.addEventListener('input', (e) => {
    const id = S.selected;
    if (!id || isRunning(id)) return;
    const t = e.target;
    if (t.id === 'lineName') return mutate(id, (d) => (d.name = t.value));
    if (t.dataset.f && t.type !== 'checkbox') {
      return mutate(id, (d) => setPath(d, t.dataset.f, t.type === 'number' ? Number(t.value) : t.value));
    }
    const card = t.closest('.step');
    if (card && t.dataset.s && t.tagName !== 'SELECT') mutate(id, (d) => (d.steps[+card.dataset.i][t.dataset.s] = t.value));
  });

  panel.addEventListener('change', (e) => {
    const id = S.selected;
    if (!id || isRunning(id)) return;
    const t = e.target;
    if (t.dataset.f && t.type === 'checkbox') return mutate(id, (d) => setPath(d, t.dataset.f, t.checked));
    if (t.dataset.act === 'template' && t.value) {
      const tpl = t.value;
      t.value = '';
      return safe(async () => {
        const tplData = await api('GET', `/api/templates/${encodeURIComponent(tpl)}`);
        mutate(id, (d) => {
          d.steps = tplData.steps;
          d.loop = tplData.loop;
        });
        renderPanel();
      })();
    }
    const card = t.closest('.step');
    if (card && t.tagName === 'SELECT') {
      const i = +card.dataset.i;
      if (t.dataset.s === 'model' && t.value === '__custom__' && !askCustomModel(t)) return;
      mutate(id, (d) => {
        const st = d.steps[i];
        st[t.dataset.s] = t.value;
        if (t.dataset.s === 'role') st.skills = [...S.data.roles[t.value].defaultSkills];
        // Cada IA tem seus próprios modelos: trocar de IA volta para o padrão.
        if (t.dataset.s === 'worker') {
          st.model = '';
          st.effort = '';
        }
        if (t.dataset.s === 'model' && st.effort && !effortsFor(st.worker, st.model || S.data.settings.workers[st.worker].model).includes(st.effort)) st.effort = '';
      });
      renderPanel();
    }
  });

  panel.addEventListener('click', safe(async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      S.tab = tab.dataset.tab;
      return renderPanel();
    }
    const chip = e.target.closest('[data-skill]');
    const id = S.selected;
    if (chip && id && !isRunning(id)) {
      const i = +chip.closest('.step').dataset.i;
      mutate(id, (d) => {
        const sk = d.steps[i].skills;
        const k = chip.dataset.skill;
        d.steps[i].skills = sk.includes(k) ? sk.filter((x) => x !== k) : [...sk, k];
      });
      chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') !== 'true');
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn || !id) return;
    const act = btn.dataset.act;
    if (act === 'close') {
      S.selected = null;
      office.setSelected(null);
      renderPanel();
      renderOffice();
      return;
    }
    if (act === 'run') {
      await flushSave(id);
      S.tab = 'vivo';
      await api('POST', `/api/lines/${id}/run`);
      renderPanel();
    } else if (act === 'stop') {
      await api('POST', `/api/lines/${id}/stop`);
    } else if (act === 'delete') {
      if (!confirm('Remover esta linha? (o worktree e o branch no git continuam existindo)')) return;
      clearTimeout(S.saveTimers.get(id));
      S.saveTimers.delete(id);
      await api('DELETE', `/api/lines/${id}`);
      S.selected = null;
      S.drafts.delete(id);
    } else if (act === 'clear-model') {
      const i = +btn.closest('.step').dataset.i;
      mutate(id, (d) => {
        d.steps[i].model = '';
        d.steps[i].effort = '';
      });
      renderPanel();
    } else if (act === 'pick-workdir') {
      const line = getLine(id);
      const picked = await pickFolder(draft(id).workdir || S.data.settings.defaultWorkdir);
      if (!picked) return;
      mutate(id, (d) => (d.workdir = picked));
      renderPanel();
      if (!line.run) toast(`Pasta da linha: ${picked}`);
    } else if (act === 'capture-now') {
      await flushSave(id);
      btn.disabled = true;
      btn.textContent = '📸 Capturando…';
      try {
        const r = await api('POST', `/api/lines/${id}/capture`);
        S.captures = { lineId: id, list: r.captures };
        toast(r.problems.length ? `Capturado, com ${r.problems.length} aviso(s) do navegador` : 'Capturado sem erros no navegador');
        S.captureProblems = r.problems;
      } finally {
        if (S.tab === 'capturas') renderCaptures($('.panel-body'), getLine(id), true);
      }
    } else if (act === 'refresh-diff') {
      S.diff = null;
      renderDiff($('.panel-body'), getLine(id));
    } else if (['add', 'up', 'down', 'remove'].includes(act)) {
      const card = btn.closest('.step');
      const i = card ? +card.dataset.i : -1;
      mutate(id, (d) => {
        if (act === 'add') {
          const prev = d.steps.at(-1);
          const role = prev && prev.role === 'executar' && prev.worker !== btn.dataset.worker ? 'revisar' : 'executar';
          d.steps.push({ worker: btn.dataset.worker, role, instruction: '', skills: [...S.data.roles[role].defaultSkills], model: '' });
        }
        if (act === 'remove') d.steps.splice(i, 1);
        if (act === 'up' && i > 0) [d.steps[i - 1], d.steps[i]] = [d.steps[i], d.steps[i - 1]];
        if (act === 'down' && i < d.steps.length - 1) [d.steps[i + 1], d.steps[i]] = [d.steps[i], d.steps[i + 1]];
      });
      renderPanel();
    }
  }));
}

function wireModal() {
  const m = $('#modal');
  $('#modalClose').onclick = () => m.close();
  m.addEventListener('click', (e) => {
    if (e.target === m) m.close();
  });
  m.addEventListener('toggle', safe(async (e) => {
    const card = e.target.closest?.('[data-skill-card]');
    if (!card || !card.open || card.dataset.loaded) return;
    const s = await api('GET', `/api/skills/${encodeURIComponent(card.dataset.skillCard)}`);
    card.dataset.loaded = '1';
    $('pre', card).textContent = s.body;
  }), true);
  m.addEventListener('click', safe(async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'reset-stats') {
      if (!confirm('Zerar os números do comparativo?')) return;
      await api('POST', '/api/stats/reset');
      $('#modalBody').innerHTML = compareHtml();
    } else if (act === 'pick-default') {
      const input = $('input[name="defaultWorkdir"]');
      const picked = await pickFolder(input.value);
      if (picked) input.value = picked;
    } else if (act === 'add-price') {
      const tbody = $('#pricingRows');
      tbody.insertAdjacentHTML('beforeend', pricingRow(Date.now(), '', {}));
      tbody.lastElementChild.querySelector('input').focus();
    } else if (act === 'del-price') {
      e.target.closest('tr').remove();
    } else if (act === 'billing-refresh') {
      S.data.billing = await api('POST', '/api/billing/refresh');
      $('#modalBody').innerHTML = costsHtml();
      renderCosts();
    } else if (act === 'detect') {
      await api('POST', '/api/detect');
      $('#modalBody').innerHTML = settingsHtml();
      toast('Detecção concluída');
    }
  }));
  m.addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { workers: { claude: {}, codex: {} } };
    const rows = {};
    for (const [k, v] of fd.entries()) {
      const [a, b, c] = k.split('.');
      if (a === 'price') (rows[b] ??= {})[c] = v;
      else if (b) body.workers[a][b] = v;
      else body[a] = v;
    }
    body.pricing = {};
    for (const r of Object.values(rows)) {
      const name = String(r.name || '').trim().toLowerCase();
      if (name) body.pricing[name] = { input: +r.input || 0, cacheRead: +r.cacheRead || 0, cacheWrite: +r.cacheWrite || 0, output: +r.output || 0 };
    }
    await api('PUT', '/api/settings', body);
    m.close();
    toast('Configurações salvas');
  }));
}

// ---- custos ----------------------------------------------------------------

/** Etapas rodando agora (modo real), com o custo parcial ao vivo. */
function runningAttempts(worker) {
  const out = [];
  for (const line of S.data.lines) {
    if (line.run?.status !== 'running') continue;
    for (const a of line.run.attempts) {
      if (a.status === 'running' && a.mode === 'real' && (!worker || a.worker === worker)) out.push({ line, a });
    }
  }
  return out;
}
const liveCost = (worker) => runningAttempts(worker).reduce((acc, { a }) => acc + (a.cost || 0), 0);
const todayCost = (worker) => (S.data.costDaily?.[dayKey()]?.[worker] ?? 0) + liveCost(worker);
function monthCost(worker) {
  const prefix = dayKey().slice(0, 7);
  const past = Object.entries(S.data.costDaily ?? {})
    .filter(([d]) => d.startsWith(prefix))
    .reduce((acc, [, v]) => acc + (v[worker] ?? 0), 0);
  return past + liveCost(worker);
}

const ACCOUNTS = { anthropic: 'Conta Anthropic', openai: 'Conta OpenAI' };

function renderCosts() {
  const el = $('#costs');
  if (!el || !S.data) return;
  const workers = Object.keys(WORKER_STYLE);
  const live = workers.reduce((a, w) => a + liveCost(w), 0);
  const today = workers.reduce((a, w) => a + todayCost(w), 0);
  const parts = [];
  parts.push(`<span class="cost-item${live ? ' live' : ''}"><span class="cost-dot"></span><small>agora</small> ${fmtUsd(live)}</span>`);
  parts.push(`<span class="cost-item"><small>hoje</small> ${fmtUsd(today)}</span>`);
  for (const [id, b] of Object.entries(S.data.billing ?? {})) {
    if (!b.configured) continue;
    const val = b.error ? '<span class="cost-err">erro</span>' : b.monthUsd == null ? '…' : fmtUsd(b.monthUsd);
    parts.push(`<span class="cost-item"><small>${id === 'anthropic' ? 'Anthropic' : 'OpenAI'} mês</small> ${val}</span>`);
  }
  el.innerHTML = parts.join('');
}

function costsHtml() {
  const workers = Object.keys(WORKER_STYLE);
  const now = runningAttempts();
  const nowHtml = now.length
    ? `<table><thead><tr><th>Linha</th><th>IA · modelo</th><th>Tokens</th><th>Custo</th></tr></thead><tbody>${now
        .map(({ line, a }) => `<tr><td>${esc(line.name)}</td><td><span class="dot" style="--wc:${WORKER_STYLE[a.worker].color}"></span>${esc(wname(a.worker))} · ${esc(a.usage.model || 'padrão')}</td><td>${fmt(total(a.usage))}</td><td>${a.costExact ? '' : '≈'}${fmtUsd(a.cost)}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="compare-note">Nenhuma IA trabalhando agora.</p>';

  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(dayKey(d));
  }
  const rowFor = (day) => {
    const v = S.data.costDaily?.[day] ?? {};
    const live = day === dayKey() ? Object.fromEntries(workers.map((w) => [w, liveCost(w)])) : {};
    const cells = workers.map((w) => (v[w] ?? 0) + (live[w] ?? 0));
    if (!cells.some(Boolean)) return '';
    return `<tr><td>${day === dayKey() ? 'hoje' : day.split('-').reverse().slice(0, 2).join('/')}</td>${cells.map((c) => `<td>${c ? fmtUsd(c) : '—'}</td>`).join('')}<td>${fmtUsd(cells.reduce((a, b) => a + b, 0))}</td></tr>`;
  };
  const dayRows = days.map(rowFor).join('');
  const monthCells = workers.map(monthCost);

  const accounts = Object.entries(S.data.billing ?? {})
    .map(([id, b]) => {
      if (!b.configured) {
        return `<div class="account off"><b>${ACCOUNTS[id]}</b><span>não configurada — coloque <code>${esc(b.env)}</code> no arquivo <code>.env</code> e reinicie</span></div>`;
      }
      if (b.error) return `<div class="account err"><b>${ACCOUNTS[id]}</b><span>erro: ${esc(b.error)}</span></div>`;
      return `<div class="account"><b>${ACCOUNTS[id]}</b><span>mês ${b.monthUsd == null ? '…' : fmtUsd(b.monthUsd)} · hoje (UTC) ${b.todayUsd == null ? '…' : fmtUsd(b.todayUsd)}</span><small>${b.updatedAt ? `atualizado ${ago(b.updatedAt)}` : 'carregando…'}</small></div>`;
    })
    .join('');

  return `<h3>Agora</h3>${nowHtml}
    <h3>Gasto das linhas do AI Office</h3>
    <table class="costs-table"><thead><tr><th>Dia</th>${workers.map((w) => `<th>${esc(wname(w))}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>${dayRows || `<tr><td colspan="${workers.length + 2}">Nenhum gasto real ainda.</td></tr>`}</tbody>
      <tfoot><tr><td>Mês</td>${monthCells.map((c) => `<td>${fmtUsd(c)}</td>`).join('')}<td>${fmtUsd(monthCells.reduce((a, b) => a + b, 0))}</td></tr></tfoot>
    </table>
    <p class="compare-note">Claude: custo informado pelo CLI. Codex: estimativa pela tabela de preços. Com assinatura (Claude Pro/Max, ChatGPT Plus/Pro) o valor é o equivalente em API — a cobrança real é a mensalidade.</p>
    <h3>Contas (gasto real da organização)</h3>
    ${accounts}
    <p class="compare-note">Lido das APIs de custo com chaves de <b>administrador</b> (só existem em organizações na API, não em contas individuais nem assinaturas). Inclui tudo o que a organização gastou, não só o AI Office. Os dados chegam com alguns minutos de atraso.</p>
    <button class="btn small" data-act="billing-refresh" ${Object.values(S.data.billing ?? {}).some((b) => b.configured) ? '' : 'disabled'}>Atualizar contas agora</button>`;
}

// ---- modelos ---------------------------------------------------------------

/** Na etapa só aparece o modelo e o esforço em uso; a escolha fica no cartão da IA, no topo. */
function modelLine(s) {
  const cfg = S.data.settings.workers[s.worker];
  const model = s.model || cfg.model;
  const effort = s.effort || cfg.effort;
  const own = Boolean(s.model || s.effort);
  return `<div class="model-line" title="Troque no cartão do ${esc(wname(s.worker))}, no topo da tela">
    <span>🧠 <b>${esc(modelLabel(s.worker, model) || 'Padrão do CLI')}</b></span>
    <span>· esforço <b>${esc(effort ? EFFORT_LABEL[effort] ?? effort : 'padrão')}</b></span>
    ${own ? '<button type="button" class="btn ghost small" data-act="clear-model" title="Esta etapa tinha um modelo próprio; volta a usar o do topo">usar o do topo</button>' : ''}
  </div>`;
}

const EFFORT_LABEL = { low: 'baixo', medium: 'médio', high: 'alto', xhigh: 'muito alto', max: 'máximo', ultra: 'ultra' };
const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const models = (w) => S.data.models?.[w]?.models ?? [];
const modelInfo = (w, id) => models(w).find((m) => m.id === id);
const modelLabel = (w, id) => (id ? modelInfo(w, id)?.label ?? id : '');
const effortsFor = (w, id) => {
  const m = id && modelInfo(w, id);
  return m?.efforts?.length ? m.efforts : DEFAULT_EFFORTS;
};

function modelOptions(w, selected, defaultLabel) {
  const opts = [`<option value="">${esc(defaultLabel)}</option>`];
  for (const m of models(w)) opts.push(`<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.label)}</option>`);
  if (selected && !modelInfo(w, selected)) opts.push(`<option value="${esc(selected)}" selected>${esc(selected)}</option>`);
  opts.push('<option value="__custom__">Outro… (digitar)</option>');
  return opts.join('');
}

function effortOptions(w, model, selected, defaultLabel) {
  const list = effortsFor(w, model);
  const opts = [`<option value="">${esc(defaultLabel)}</option>`];
  for (const e of list) opts.push(`<option value="${e}" ${e === selected ? 'selected' : ''}>${EFFORT_LABEL[e] ?? e}</option>`);
  if (selected && !list.includes(selected)) opts.push(`<option value="${esc(selected)}" selected>${esc(selected)}</option>`);
  return opts.join('');
}

/** "Outro…": pede o nome do modelo; devolve false (e desfaz) se cancelar ou for inválido. */
function askCustomModel(sel) {
  const v = (prompt('Nome exato do modelo (como o CLI aceita em --model / -m):') ?? '').trim();
  if (!v || !/^[\w.:\-[\]/]{1,80}$/.test(v)) {
    if (v) toast('Nome de modelo inválido', true);
    sel.value = sel.dataset.prev ?? '';
    return false;
  }
  if (![...sel.options].some((o) => o.value === v)) sel.add(new Option(v, v), sel.options.length - 1);
  sel.value = v;
  return true;
}

function pricingRow(i, name, p) {
  const cell = (f) => `<td><input type="number" min="0" step="any" name="price.${i}.${f}" value="${p[f] ?? 0}" aria-label="${f}"></td>`;
  return `<tr><td><input type="text" name="price.${i}.name" value="${esc(name)}" placeholder="nome-do-modelo" aria-label="modelo"></td>${['input', 'cacheRead', 'cacheWrite', 'output'].map(cell).join('')}<td><button class="btn ghost small" type="button" data-act="del-price" aria-label="Remover">✕</button></td></tr>`;
}

// ---- escolher pasta -------------------------------------------------------

const PICK = { resolve: null, path: '', data: null };

/** Abre o navegador de pastas; devolve o caminho escolhido (ou null). */
function pickFolder(start) {
  const dlg = $('#picker');
  return new Promise((resolve) => {
    PICK.resolve = resolve;
    dlg.showModal();
    loadFolder(start || '');
  });
}

function closePicker(value) {
  const r = PICK.resolve;
  PICK.resolve = null;
  $('#picker').close();
  r?.(value ?? null);
}

async function loadFolder(p) {
  const list = $('#pickList');
  list.innerHTML = '<div class="empty">Carregando…</div>';
  try {
    const data = await api('GET', `/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ''}`);
    PICK.data = data;
    PICK.path = data.path;
    $('#pickPath').value = data.path;
    $('#pickRoots').innerHTML = data.roots.map((r) => `<button class="btn small ghost" data-path="${esc(r.path)}">${r.label === 'Início' ? '🏠 Início' : `💽 ${esc(r.label)}`}</button>`).join('');
    list.innerHTML = data.folders.length
      ? data.folders
          .map((f) => `<button class="pick-item" role="option" data-path="${esc(f.path)}" title="${esc(f.path)}"><span>📁</span><span class="pick-name">${esc(f.name)}</span>${f.git ? '<span class="git-badge">git</span>' : ''}</button>`)
          .join('')
      : '<div class="empty">Sem subpastas aqui.</div>';
    $('#pickInfo').innerHTML = data.git
      ? '<span class="ok-text">✔ Repositório git</span> — cada linha trabalha numa cópia isolada (worktree).'
      : 'Esta pasta <b>não é um repositório git</b>: as IAs trabalham direto nela, sem diff nem worktree.';
    $('[data-pick="up"]').disabled = !data.parent;
  } catch (e) {
    list.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

function wirePicker() {
  const dlg = $('#picker');
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    closePicker(null);
  });
  dlg.addEventListener('click', safe(async (e) => {
    if (e.target === dlg) return closePicker(null);
    const item = e.target.closest('[data-path]');
    if (item) return loadFolder(item.dataset.path);
    const act = e.target.closest('[data-pick]')?.dataset.pick;
    if (act === 'close') closePicker(null);
    else if (act === 'up' && PICK.data?.parent) loadFolder(PICK.data.parent);
    else if (act === 'use') closePicker(PICK.path);
    else if (act === 'native') {
      const btn = e.target.closest('[data-pick]');
      btn.disabled = true;
      btn.textContent = '🖥️ Escolha na janela que abriu…';
      try {
        const r = await api('POST', '/api/fs/pick', { start: PICK.path });
        if (r.path) closePicker(r.path);
      } finally {
        btn.disabled = false;
        btn.textContent = '🖥️ Abrir janela do sistema';
      }
    }
  }));
  // duplo clique numa pasta = entrar e já usar
  dlg.addEventListener('dblclick', (e) => {
    const item = e.target.closest('.pick-item');
    if (item) closePicker(item.dataset.path);
  });
  $('#pickPathForm').addEventListener('submit', (e) => {
    e.preventDefault();
    loadFolder($('#pickPath').value.trim());
  });
}

const createLine = safe(async () => {
  // O modelo da linha (Claude faz → Codex revisa etc.) se escolhe dentro dela, em "Aplicar modelo…".
  const line = await api('POST', '/api/lines', {});
  selectLine(line.id, { tab: 'etapas' });
});

// ---- painéis Escritório, Atividade e barra ---------------------------------

const portraitCache = {};
const portraitURL = (w) => (portraitCache[w] ??= sprite(w, 'portrait', 3).toDataURL());
const letter = (w) => `<span class="letter" style="--wc:${WORKER_STYLE[w].color}">${WORKER_STYLE[w].letter}</span>`;
const UI = { search: '', hide: new Set(), feedTimer: null };

function selectLine(id, { tab = null, focus = true } = {}) {
  if (S.selected !== id) S.diff = null;
  S.selected = id;
  if (tab) S.tab = tab;
  else if (isRunning(id) && S.tab === 'etapas') S.tab = 'vivo';
  office.setSelected(id);
  renderPanel();
  renderOffice();
  if (focus) requestAnimationFrame(() => office.focusLine(id));
}

/** Avisa o mapa de quanto espaço os painéis ocupam, para enquadrar o prédio no meio. */
function updateInsets() {
  const tb = $('#topbar');
  document.documentElement.style.setProperty('--topbar-h', `${tb.offsetHeight}px`);
  const vw = window.innerWidth;
  const vis = (el) => el && !el.hidden && getComputedStyle(el).display !== 'none';
  const left = $('#officePanel');
  const right = $('#panel');
  const bottom = $('#activity');
  const narrow = vw <= 760;
  office.setInsets({
    left: !narrow && vis(left) ? left.getBoundingClientRect().right : 0,
    right: !narrow && vis(right) ? vw - right.getBoundingClientRect().left : 0,
    bottom: vis(bottom) ? window.innerHeight - bottom.getBoundingClientRect().top : 0,
    top: 0,
  });
  if (!office.userMoved) office.fit();
}

function renderStats() {
  const lines = S.data.lines;
  const by = (f) => lines.filter(f).length;
  const working = by((l) => l.run?.status === 'running');
  const approved = by((l) => lineStatus(l) === 'aprovado');
  const pending = by((l) => lineStatus(l) === 'pendente');
  const failed = by((l) => ['failed', 'budget'].includes(lineStatus(l)));
  const stat = (n, label, cls = '') => `<div class="stat ${n && cls ? cls : ''}"><b>${n}</b><small>${label}</small></div>`;
  $('#stats').innerHTML = stat(lines.length, 'linhas') + stat(working, 'trabalhando', 'hot') + stat(approved, 'aprovadas') + stat(pending, 'pendentes') + stat(failed, 'com erro', 'bad');
  $('#simBadge').hidden = !Object.values(S.data.workers).some((i) => i.mode === 'simulado');
}

/** Estado de uma etapa para a lista: ponto colorido e texto. */
function stepState(line, i) {
  const s = line.steps[i];
  const last = line.run?.attempts?.filter((a) => a.step === i).at(-1);
  if (!last) return { dot: '', text: s.instruction ? `📝 ${s.instruction}` : 'Aguardando' };
  if (last.status === 'running') return { dot: 'running', text: `${activityIcon(last.activity)} ${last.activity || 'trabalhando…'}`, active: true };
  if (last.status === 'failed') return { dot: 'failed', text: `⚠️ ${last.error || 'falhou'}` };
  if (last.status === 'stopped') return { dot: 'stopped', text: '■ parada' };
  if (last.verdict === 'MUDANCAS_NECESSARIAS') return { dot: 'changes', text: '↺ pediu mudanças' };
  return { dot: 'done', text: last.verdict === 'APROVADO' ? '✔ aprovou' : '✔ concluída' };
}

function renderOffice() {
  const list = $('#lineList');
  if (!list || !S.data) return;
  $('#filters').innerHTML = Object.keys(WORKER_STYLE)
    .map((w) => `<button class="filter-chip" data-filter="${w}" aria-pressed="${!UI.hide.has(w)}">${letter(w)} ${esc(wname(w))}</button>`)
    .join('');
  const q = UI.search.trim().toLowerCase();
  const lines = S.data.lines.filter((l) => {
    if (l.steps.length && l.steps.every((s) => UI.hide.has(s.worker))) return false;
    if (!q) return true;
    return [l.name, l.workdir, ...l.steps.map((s) => `${wname(s.worker)} ${s.instruction}`)].join(' ').toLowerCase().includes(q);
  });
  if (!S.data.lines.length) {
    list.innerHTML = welcomeHtml();
    return;
  }
  if (!lines.length) {
    list.innerHTML = '<div class="empty">Nada encontrado.</div>';
    return;
  }
  list.innerHTML = lines
    .map((l) => {
      const st = lineStatus(l);
      const color = STATUS_TEXT[st][1];
      const states = l.steps.map((_, i) => stepState(l, i));
      const done = states.filter((x) => x.dot === 'done').length;
      const workers = [...new Set(l.steps.map((s) => s.worker))];
      const rows = l.steps
        .map(
          (s, i) => `<div class="agent-row ${states[i].active ? 'active' : ''}">
            <img src="${portraitURL(s.worker)}" alt="">
            <div>
              <div class="who">${esc(wname(s.worker))} ${letter(s.worker)}<span class="role">${i + 1}. ${esc(S.data.roles[s.role]?.label ?? s.role)}</span></div>
              <div class="act" title="${esc(states[i].text)}">${esc(states[i].text)}</div>
            </div>
            <span class="sdot ${states[i].dot}" title="${esc(states[i].dot || 'aguardando')}"></span>
          </div>`,
        )
        .join('');
      return `<div class="line-card ${l.id === S.selected ? 'selected' : ''}" data-line="${l.id}" style="--sc:${color}" tabindex="0" role="button" aria-label="Abrir ${esc(l.name)}">
        <div class="lc-head"><b>${esc(l.name)}</b><span class="count">${l.steps.length}</span><span class="letters">${workers.map(letter).join('')}</span></div>
        <div class="lc-path">${esc(l.workdir || S.data.settings.defaultWorkdir || 'pasta não definida')}</div>
        <div class="lc-progress"><span class="track"><span style="width:${l.steps.length ? Math.round((done / l.steps.length) * 100) : 0}%"></span></span><small>${done}/${l.steps.length} · ${esc(STATUS_TEXT[st][0])}${l.run?.round > 1 ? ` · rodada ${l.run.round}` : ''}</small></div>
        ${rows}
      </div>`;
    })
    .join('');
}

function scheduleFeed() {
  if (UI.feedTimer) return;
  UI.feedTimer = setTimeout(() => {
    UI.feedTimer = null;
    renderFeed();
  }, 200);
}

function renderFeed() {
  const feed = $('#feed');
  if (!feed || !S.data) return;
  const names = Object.fromEntries(S.data.lines.map((l) => [l.id, l.name]));
  const all = [];
  for (const [lineId, entries] of S.logs) {
    if (!names[lineId]) continue;
    for (const e of entries.slice(-60)) if (e.kind !== 'thinking') all.push({ ...e, lineId });
  }
  all.sort((a, b) => a.t - b.t);
  const rows = all.slice(-80);
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  feed.innerHTML = rows.length
    ? rows
        .map((e) => {
          const w = e.worker;
          const text = String(e.text).split('\n')[0];
          return `<div class="feed-row ${esc(e.kind)}" data-line="${e.lineId}">
            <time>${new Date(e.t).toLocaleTimeString('pt-BR', { hour12: false })}</time>
            ${w ? `<img src="${portraitURL(w)}" alt="">` : '<span></span>'}
            <span class="fw">${w ? esc(wname(w)) : 'Escritório'}</span>
            <span class="fl">${w ? letter(w) : ''}${esc(names[e.lineId])}</span>
            <span class="ft" title="${esc(text)}">${e.kind === 'error' ? '⚠️' : e.kind === 'done' ? '✅' : activityIcon(text)} ${esc(text)}</span>
          </div>`;
        })
        .join('')
    : '<div class="empty">Quando uma linha rodar, o que cada IA faz aparece aqui.</div>';
  if (stick) feed.scrollTop = feed.scrollHeight;
}

function drawBrand() {
  const c = $('#brandIcon').getContext('2d');
  const px = (x, y, w, h, col) => {
    c.fillStyle = col;
    c.fillRect(x * 2, y * 2, w * 2, h * 2);
  };
  px(2, 3, 10, 11, '#f1e3c6');
  px(1, 2, 12, 2, '#c4623f');
  px(1, 13, 12, 1, '#3d4150');
  for (const [x, y] of [[3, 5], [6, 5], [9, 5], [3, 8], [9, 8]]) px(x, y, 2, 2, '#5fb0ff');
  px(6, 9, 2, 4, '#7a3d3a');
  px(6, 0, 2, 2, '#e07a4f');
}

// ---- boot -----------------------------------------------------------------

const office = new Office($('#office'), {
  onLine: (id) => selectLine(id, { focus: false }),
  onNew: createLine,
  onSkills: () => openModal('Biblioteca de Skills', skillsHtml()),
  onCopa: () => openModal('Comparativo Claude × Codex', compareHtml()),
});

$('#btnNewLine').onclick = createLine;
$('#workers').addEventListener('change', safe(async (e) => {
  const t = e.target;
  const w = t.dataset.chipModel || t.dataset.chipEffort;
  if (!w) return;
  if (t.dataset.chipModel && t.value === '__custom__' && !askCustomModel(t)) return;
  const patch = t.dataset.chipModel ? { model: t.value } : { effort: t.value };
  // Modelo novo pode não ter o nível de raciocínio escolhido antes.
  const cur = S.data.settings.workers[w];
  if (patch.model !== undefined && cur.effort && !effortsFor(w, patch.model).includes(cur.effort)) patch.effort = '';
  t.blur();
  await api('PUT', '/api/settings', { workers: { [w]: patch } });
  toast(`${wname(w)}: ${patch.model !== undefined ? `modelo ${modelLabel(w, patch.model) || 'padrão do CLI'}` : `raciocínio ${EFFORT_LABEL[patch.effort] ?? 'padrão'}`}`);
}));
$('#modal').addEventListener('change', (e) => {
  const t = e.target;
  if (!t.name?.endsWith('.model')) return;
  if (t.value === '__custom__' && !askCustomModel(t)) return;
  t.dataset.prev = t.value;
  const w = t.name.split('.')[0];
  const eff = $(`select[name="${w}.effort"]`);
  if (eff) eff.innerHTML = effortOptions(w, t.value, eff.value, 'Padrão do modelo');
});
$('#btnCompare').onclick = () => openModal('Comparativo Claude × Codex', compareHtml());
$('#costs').onclick = () => openModal('Custos', costsHtml());
$('#btnSettings').onclick = () => openModal('Configurações', settingsHtml());
$('#btnSkills').onclick = () => openModal('Biblioteca de Skills', skillsHtml());
$('#btnFit').onclick = () => office.fit();
$('#btnZoomIn').onclick = () => office.zoomBy(1);
$('#btnZoomOut').onclick = () => office.zoomBy(-1);
$('#btnSidebar').onclick = () => {
  document.body.classList.toggle('left-hidden');
  $('#btnSidebar').setAttribute('aria-pressed', !document.body.classList.contains('left-hidden'));
  updateInsets();
};
$('#btnActivity').onclick = () => {
  const box = $('#activity');
  box.classList.toggle('collapsed');
  $('#btnActivity').setAttribute('aria-expanded', !box.classList.contains('collapsed'));
  updateInsets();
};
$('#search').addEventListener('input', (e) => {
  UI.search = e.target.value;
  renderOffice();
});
$('#officePanel').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (chip) {
    const w = chip.dataset.filter;
    UI.hide.has(w) ? UI.hide.delete(w) : UI.hide.add(w);
    return renderOffice();
  }
  const card = e.target.closest('[data-line]');
  if (card) selectLine(card.dataset.line);
});
$('#officePanel').addEventListener('keydown', (e) => {
  const card = e.target.closest?.('[data-line]');
  if (card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    selectLine(card.dataset.line);
  }
});
$('#feed').addEventListener('click', (e) => {
  const row = e.target.closest('[data-line]');
  if (row) selectLine(row.dataset.line, { tab: 'vivo' });
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input,textarea,select') || $('#modal').open) return;
  if (e.key === '/') {
    e.preventDefault();
    if (document.body.classList.contains('left-hidden')) $('#btnSidebar').click();
    $('#search').focus();
  } else if (e.key === 'Escape' && S.selected) {
    S.selected = null;
    office.setSelected(null);
    renderPanel();
    renderOffice();
  } else if (e.key === '+' || e.key === '=') office.zoomBy(1);
  else if (e.key === '-') office.zoomBy(-1);
});
if (window.innerWidth <= 760) {
  document.body.classList.add('left-hidden');
  $('#activity').classList.add('collapsed');
}
$('#btnSidebar').setAttribute('aria-pressed', !document.body.classList.contains('left-hidden'));
new ResizeObserver(() => updateInsets()).observe($('#topbar'));
window.addEventListener('resize', () => updateInsets());
drawBrand();
updateInsets();
wirePanel();
wireModal();
wirePicker();
office.start();
api('GET', '/api/state').then((state) => handle({ type: 'state', state })).catch((e) => toast(e.message, true));
connect();
