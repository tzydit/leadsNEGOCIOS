import { runJsonl, splitArgs } from '../proc.js';
import { READ_ONLY_ROLES, base, clip, emptyUsage } from './common.js';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(ls:*)'];

/** "Bash(npm test:*) Read, Grep" → ['Bash(npm test:*)', 'Read', 'Grep'] (espaços dentro de parênteses ficam). */
export function splitTools(str) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of String(str ?? '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (/\s/.test(ch) || ch === ',')) {
      if (cur) out.push(cur);
      cur = '';
    } else if (ch !== '"' && ch !== "'") cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function toolActivity(name, input = {}) {
  switch (name) {
    case 'Read':
      return { kind: 'tool', text: `Lendo ${base(input.file_path)}` };
    case 'Write':
      return { kind: 'file', text: `Criando ${base(input.file_path)}` };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'file', text: `Editando ${base(input.file_path || input.notebook_path)}` };
    case 'Bash':
      return { kind: 'command', text: `$ ${clip(input.command, 200)}` };
    case 'Grep':
      return { kind: 'tool', text: `Buscando "${clip(input.pattern, 60)}"` };
    case 'Glob':
      return { kind: 'tool', text: `Procurando ${clip(input.pattern, 60)}` };
    case 'WebFetch':
    case 'WebSearch':
      return { kind: 'tool', text: 'Pesquisando na web' };
    case 'TodoWrite':
      return { kind: 'tool', text: 'Organizando tarefas' };
    case 'Task':
    case 'Agent':
      return { kind: 'tool', text: 'Delegando subtarefa' };
    case 'Skill':
      return { kind: 'tool', text: `Usando skill ${input.skill ?? input.name ?? ''}`.trim() };
    default:
      return { kind: 'tool', text: name };
  }
}

/**
 * Converte um evento do `claude -p --output-format stream-json` em eventos
 * normalizados. `st` guarda o estado da etapa (uso acumulado, texto final).
 */
export function parseClaudeEvent(obj, st) {
  const events = [];
  if (obj.type === 'system' && obj.subtype === 'init') {
    if (obj.model) st.usage.model = obj.model;
    events.push({ kind: 'info', text: `Sessão Claude iniciada${obj.model ? ` (${obj.model})` : ''}` });
  } else if (obj.type === 'assistant' && obj.message) {
    const msg = obj.message;
    for (const block of msg.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        st.lastText = block.text;
        events.push({ kind: 'text', text: block.text });
      } else if (block.type === 'thinking') {
        events.push({ kind: 'thinking', text: 'Pensando…' });
      } else if (block.type === 'tool_use') {
        events.push(toolActivity(block.name, block.input));
      }
    }
    // O stream repete a mesma mensagem por bloco; conta o uso uma vez por id.
    if (msg.usage && msg.id && !st.seen.has(msg.id)) {
      st.seen.add(msg.id);
      const u = msg.usage;
      const cached = u.cache_read_input_tokens ?? 0;
      if (msg.model && !st.usage.model) st.usage.model = msg.model;
      st.usage.input += (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
      st.usage.cachedInput += cached;
      st.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
      st.usage.output += u.output_tokens ?? 0;
      st.usageChanged = true;
    }
  } else if (obj.type === 'user' && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block.type === 'tool_result' && block.is_error) {
        const t = Array.isArray(block.content) ? block.content.map((c) => c.text ?? '').join(' ') : block.content;
        events.push({ kind: 'error', text: `Ferramenta falhou: ${clip(t, 160)}` });
      }
    }
  } else if (obj.type === 'result') {
    st.finished = true;
    if (obj.usage) {
      const u = obj.usage;
      const cached = u.cache_read_input_tokens ?? 0;
      st.usage.input = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
      st.usage.cachedInput = cached;
      st.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      st.usage.output = u.output_tokens ?? 0;
    }
    if (typeof obj.total_cost_usd === 'number') st.usage.costUsd = obj.total_cost_usd;
    st.usageChanged = true;
    if (typeof obj.result === 'string' && obj.result.trim()) st.finalText = obj.result;
    if (obj.is_error || (obj.subtype && obj.subtype !== 'success')) {
      st.error = clip(obj.result || obj.subtype || 'erro', 300);
      events.push({ kind: 'error', text: `Claude terminou com erro: ${st.error}` });
    }
  }
  return events;
}

export function buildClaudeArgs({ role, config }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
  if (config.model) args.push('--model', config.model);
  if (READ_ONLY_ROLES.has(role)) {
    args.push('--permission-mode', 'dontAsk', '--allowedTools', ...READ_ONLY_TOOLS);
  } else {
    args.push('--permission-mode', 'acceptEdits');
    const tools = splitTools(config.allowedTools);
    if (tools.length) args.push('--allowedTools', ...tools);
  }
  if (Number(config.maxBudgetUsd) > 0) args.push('--max-budget-usd', String(config.maxBudgetUsd));
  args.push(...splitArgs(config.extraArgs));
  return args;
}

export function runClaude({ prompt, cwd, role, config, onEvent, onUsage }) {
  const st = { usage: emptyUsage(config.model), seen: new Set(), lastText: '', finalText: '', error: null, finished: false, usageChanged: false };
  const handle = runJsonl({
    bin: config.bin || 'claude',
    args: buildClaudeArgs({ role, config }),
    cwd,
    stdin: prompt,
    onJson: (obj) => {
      for (const ev of parseClaudeEvent(obj, st)) onEvent(ev);
      if (st.usageChanged) {
        st.usageChanged = false;
        onUsage({ ...st.usage });
      }
    },
    onText: (line) => onEvent({ kind: 'info', text: clip(line, 300) }),
  });
  const done = handle.done.then((r) => {
    const finalText = st.finalText || st.lastText;
    if (r.error) return { ok: false, finalText, usage: st.usage, error: `Não foi possível iniciar o Claude: ${r.error}` };
    if (!st.finished && r.code !== 0) {
      return { ok: false, finalText, usage: st.usage, error: clip(r.stderr || `claude saiu com código ${r.code}`, 400) };
    }
    return { ok: !st.error, finalText, usage: st.usage, error: st.error };
  });
  return { done, kill: handle.kill };
}
