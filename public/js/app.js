import { Office, STATUS_TEXT, lineStatus } from './office.js';
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
    if (S.selected === msg.line.id) renderPanel({ soft: true });
  } else if (msg.type === 'log') {
    const arr = S.logs.get(msg.lineId) ?? [];
    arr.push(msg.entry);
    if (arr.length > 400) arr.splice(0, arr.length - 400);
    S.logs.set(msg.lineId, arr);
    if (S.selected === msg.lineId && S.tab === 'vivo') appendLog(msg.entry);
  } else if (msg.type === 'stats') {
    S.data.stats = msg.stats;
    renderWorkers();
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
        const { name, workdir, useWorktree, tokenBudget, loop, steps } = d;
        await api('PUT', `/api/lines/${id}`, { name, workdir, useWorktree, tokenBudget, loop, steps });
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
  const { name, workdir, useWorktree, tokenBudget, loop, steps } = d;
  await api('PUT', `/api/lines/${id}`, { name, workdir, useWorktree, tokenBudget, loop, steps });
}

// ---- top bar --------------------------------------------------------------

function renderWorkers() {
  const box = $('#workers');
  box.innerHTML = '';
  for (const [w, info] of Object.entries(S.data.workers)) {
    const st = S.data.stats[w];
    const chip = document.createElement('div');
    chip.className = 'worker-chip';
    chip.style.setProperty('--wc', WORKER_STYLE[w].color);
    const busy = S.data.lines.filter((l) => l.run?.status === 'running' && l.run.attempts.at(-1)?.worker === w).length;
    chip.innerHTML = `
      <canvas width="24" height="36" aria-hidden="true"></canvas>
      <div>
        <div class="wname">${esc(wname(w))} <span class="mode ${info.mode}" title="${info.mode === 'simulado' ? 'CLI não encontrado ou modo simulado: nada é executado de verdade' : 'Executando o CLI de verdade'}">${info.mode}</span></div>
        <div class="wmeta">${busy ? `${busy} sala(s) ativa(s)` : 'na copa'} · ${fmt(st.input + st.output)} tokens</div>
      </div>`;
    const cv = chip.querySelector('canvas').getContext('2d');
    cv.imageSmoothingEnabled = false;
    cv.drawImage(sprite(w, 'walk0', 2), 0, 0);
    box.append(chip);
  }
  const sel = $('#tplSelect');
  if (!sel.options.length) {
    sel.innerHTML = Object.entries(S.data.templates)
      .map(([k, label]) => `<option value="${esc(k)}">${esc(label)}</option>`)
      .join('');
  }
}

// ---- painel ---------------------------------------------------------------

function renderAll() {
  office.setData(S.data);
  office.setSelected(S.selected);
  renderWorkers();
  renderPanel();
}

function renderPanel({ soft = false } = {}) {
  const panel = $('#panel');
  const line = getLine(S.selected);
  if (!line) {
    panel.innerHTML = welcomeHtml();
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
      ${[['etapas', 'Etapas', line.steps.length], ['vivo', 'Ao vivo', ''], ['diff', 'Diff', ''], ['tokens', 'Tokens', fmt(lineTokens(line))]]
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
  return `<div class="panel-body welcome">
    <h2>Bem-vindo ao escritório</h2>
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
        <input id="fWorkdir" type="text" data-f="workdir" value="${esc(d.workdir)}" placeholder="${esc(S.data.settings.defaultWorkdir || '/caminho/do/projeto')}">
      </div>
      <label class="check"><input type="checkbox" data-f="useWorktree" ${d.useWorktree ? 'checked' : ''}> Worktree isolado (git)</label>
      <div class="field">
        <label for="fBudget">Orçamento de tokens (0 = sem limite)</label>
        <input id="fBudget" type="number" min="0" step="10000" data-f="tokenBudget" value="${d.tokenBudget || 0}">
      </div>
      <label class="check inline"><input type="checkbox" data-f="loop.enabled" ${d.loop?.enabled ? 'checked' : ''}> Ciclo de revisão, até
        <input type="number" min="1" max="5" data-f="loop.maxRounds" value="${d.loop?.maxRounds ?? 2}" aria-label="Máximo de rodadas"> rodadas</label>
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
      ${S.data.skills.map((k) => `<button type="button" class="skill-chip" data-skill="${esc(k.name)}" aria-pressed="${s.skills.includes(k.name)}" title="${esc(k.description)}">${esc(k.name)}</button>`).join('')}
    </div>
    <div class="inline"><label for="mdl-${i}">Modelo</label><input id="mdl-${i}" type="text" data-s="model" value="${esc(s.model ?? '')}" placeholder="padrão das configurações" style="flex:1"></div>
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

// ---- tokens ---------------------------------------------------------------

function lineTokens(line) {
  return (line.run?.attempts ?? []).reduce((a, t) => a + total(t.usage), 0);
}

function tokensHtml(line) {
  const at = line.run?.attempts ?? [];
  if (!at.length) return '<div class="empty">Rode a linha para ver o consumo de cada etapa.</div>';
  const sum = at.reduce((a, t) => ({ input: a.input + t.usage.input, cachedInput: a.cachedInput + t.usage.cachedInput, output: a.output + t.usage.output, costUsd: a.costUsd + (t.usage.costUsd || 0), ms: a.ms + ((t.endedAt || Date.now()) - t.startedAt) }), { input: 0, cachedInput: 0, output: 0, costUsd: 0, ms: 0 });
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
        <td>${t.usage.costUsd ? `$${t.usage.costUsd.toFixed(3)}` : '—'}</td>
        <td>${fmtMs((t.endedAt || Date.now()) - t.startedAt)}</td></tr>`,
      )
      .join('')}</tbody>
    <tfoot><tr><td colspan="2">Total</td><td>${fmt(sum.input)}</td><td>${fmt(sum.cachedInput)}</td><td>${fmt(sum.output)}</td><td>${sum.costUsd ? `$${sum.costUsd.toFixed(3)}` : '—'}</td><td>${fmtMs(sum.ms)}</td></tr></tfoot>
  </table>
  <p class="compare-note">${cachePct}% da entrada veio do cache (mais barato). O custo em dólar só é informado pelo Claude.</p>${budget}`;
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
    ['Custo total', (s) => s.costUsd, (v) => (v ? `$${v.toFixed(2)}` : '—')],
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
        <div class="field"><label>Modelo padrão</label><input type="text" name="${k}.model" value="${esc(c.model)}" placeholder="padrão do CLI"></div>
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
      <div class="field full"><label>Pasta padrão do projeto</label><input type="text" name="defaultWorkdir" value="${esc(s.defaultWorkdir)}" placeholder="/home/voce/projetos/meu-site"></div>
      <div class="field"><label>Máx. caracteres de diff para o revisor</label><input type="number" min="1000" step="1000" name="diffMaxChars" value="${s.diffMaxChars}"></div>
      <div class="field"><label>Máx. caracteres do resumo repassado</label><input type="number" min="200" step="100" name="handoffMaxChars" value="${s.handoffMaxChars}"></div>
    </div>
    ${workerForm('claude')}${workerForm('codex')}
    <p class="compare-note">Revisores e auditores rodam em modo somente leitura (Claude com ferramentas de leitura; Codex com sandbox read-only). Executores podem editar arquivos da pasta.</p>
    <div class="run-row"><button class="btn primary" type="submit">Salvar</button><button class="btn" type="button" data-act="detect">Detectar CLIs de novo</button></div>
  </form>`;
}

function skillsHtml() {
  return `<p class="compare-note" style="margin-top:0">Ative as skills por etapa no painel da linha. Elas vão dentro do prompt da etapa. Para usar no Claude Code e no Codex em todas as sessões, rode <code>npm run skills:global</code> (ou <code>npm run skills:install -- /caminho/do/projeto</code> para um projeto só).</p>
  ${S.data.skills.map((k) => `<details class="skill-card" data-skill-card="${esc(k.name)}"><summary>${esc(k.name)}</summary><p>${esc(k.description)}</p><pre>carregando…</pre></details>`).join('')}`;
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
      mutate(id, (d) => {
        d.steps[i][t.dataset.s] = t.value;
        if (t.dataset.s === 'role') d.steps[i].skills = [...S.data.roles[t.value].defaultSkills];
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
    for (const [k, v] of fd.entries()) {
      const [a, b] = k.split('.');
      if (b) body.workers[a][b] = v;
      else body[a] = v;
    }
    await api('PUT', '/api/settings', body);
    m.close();
    toast('Configurações salvas');
  }));
}

const createLine = safe(async () => {
  const line = await api('POST', '/api/lines', { template: $('#tplSelect').value });
  S.selected = line.id;
  S.tab = 'etapas';
  office.setSelected(line.id);
  renderPanel();
});

// ---- boot -----------------------------------------------------------------

const office = new Office($('#office'), {
  onLine: (id) => {
    if (S.selected !== id) S.diff = null;
    S.selected = id;
    office.setSelected(id);
    if (isRunning(id) && S.tab === 'etapas') S.tab = 'vivo';
    renderPanel();
  },
  onNew: createLine,
  onSkills: () => openModal('Biblioteca de Skills', skillsHtml()),
  onCopa: () => openModal('Comparativo Claude × Codex', compareHtml()),
});

$('#btnNewLine').onclick = createLine;
$('#btnCompare').onclick = () => openModal('Comparativo Claude × Codex', compareHtml());
$('#btnSettings').onclick = () => openModal('Configurações', settingsHtml());
wirePanel();
wireModal();
office.start();
api('GET', '/api/state').then((state) => handle({ type: 'state', state })).catch((e) => toast(e.message, true));
connect();
