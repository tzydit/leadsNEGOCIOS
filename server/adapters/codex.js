import { runJsonl, splitArgs } from '../proc.js';
import { READ_ONLY_ROLES, clip, emptyUsage } from './common.js';

// `bash -lc 'npm test'` → `npm test`
function cleanCommand(cmd) {
  const s = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '');
  const m = s.match(/^(?:\/\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+(['"]?)([\s\S]*)\1$/);
  return m ? m[2] : s;
}

/** Converte um evento do `codex exec --json` em eventos normalizados. */
export function parseCodexEvent(obj, st) {
  const events = [];
  const type = obj.type;
  const item = obj.item;

  if (type === 'thread.started') {
    events.push({ kind: 'info', text: 'Sessão Codex iniciada' });
  } else if ((type === 'item.started' || type === 'item.updated' || type === 'item.completed') && item) {
    const started = type === 'item.started';
    const completed = type === 'item.completed';
    switch (item.type) {
      case 'agent_message':
        if (completed && item.text?.trim()) {
          st.lastText = item.text;
          events.push({ kind: 'text', text: item.text });
        }
        break;
      case 'reasoning':
        if (completed) events.push({ kind: 'thinking', text: clip(item.text || 'Pensando…', 200) });
        break;
      case 'command_execution':
        if (started) events.push({ kind: 'command', text: `$ ${clip(cleanCommand(item.command), 200)}` });
        else if (completed && item.exit_code != null && item.exit_code !== 0) {
          events.push({ kind: 'error', text: `Comando saiu com código ${item.exit_code}: ${clip(cleanCommand(item.command), 120)}` });
        }
        break;
      case 'file_change':
        if (completed) {
          for (const ch of item.changes ?? []) {
            const verb = ch.kind === 'add' ? 'Criando' : ch.kind === 'delete' ? 'Removendo' : 'Editando';
            events.push({ kind: 'file', text: `${verb} ${String(ch.path ?? '').split(/[\\/]/).pop()}` });
          }
        }
        break;
      case 'mcp_tool_call':
        if (started) events.push({ kind: 'tool', text: `MCP ${item.server ?? ''}.${item.tool ?? ''}` });
        break;
      case 'web_search':
        if (started || completed) events.push({ kind: 'tool', text: `Pesquisando: ${clip(item.query, 80)}` });
        break;
      case 'todo_list':
        if (started) events.push({ kind: 'tool', text: 'Organizando tarefas' });
        break;
      case 'error':
        events.push({ kind: 'error', text: clip(item.message, 300) });
        break;
      default:
        break;
    }
  } else if (type === 'turn.completed' && obj.usage) {
    const u = obj.usage;
    st.usage.input += u.input_tokens ?? 0;
    st.usage.cachedInput += u.cached_input_tokens ?? 0;
    st.usage.output += (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
    st.usageChanged = true;
    st.finished = true;
  } else if (type === 'turn.failed') {
    st.error = clip(obj.error?.message ?? 'falha no turno', 300);
    events.push({ kind: 'error', text: st.error });
  } else if (type === 'error') {
    st.error = clip(obj.message ?? 'erro', 300);
    events.push({ kind: 'error', text: st.error });
  } else if (obj.msg?.type) {
    // Formato antigo do `codex exec --json` (versões < 0.40).
    const m = obj.msg;
    if (m.type === 'agent_message' && m.message) {
      st.lastText = m.message;
      events.push({ kind: 'text', text: m.message });
    } else if (m.type === 'exec_command_begin') {
      events.push({ kind: 'command', text: `$ ${clip(cleanCommand(m.command), 200)}` });
    } else if (m.type === 'token_count') {
      const u = m.info?.total_token_usage ?? m;
      if (u.input_tokens != null) {
        st.usage.input = u.input_tokens;
        st.usage.cachedInput = u.cached_input_tokens ?? 0;
        st.usage.output = u.output_tokens ?? 0;
        st.usageChanged = true;
      }
    } else if (m.type === 'task_complete') {
      st.finished = true;
    } else if (m.type === 'error') {
      st.error = clip(m.message, 300);
      events.push({ kind: 'error', text: st.error });
    }
  }
  return events;
}

export function buildCodexArgs({ role, cwd, config }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', cwd];
  args.push('--sandbox', READ_ONLY_ROLES.has(role) ? 'read-only' : 'workspace-write');
  if (config.model) args.push('-m', config.model);
  args.push(...splitArgs(config.extraArgs));
  args.push('-'); // prompt via stdin
  return args;
}

export function runCodex({ prompt, cwd, role, config, onEvent, onUsage }) {
  const st = { usage: emptyUsage(config.model), lastText: '', error: null, finished: false, usageChanged: false };
  const handle = runJsonl({
    bin: config.bin || 'codex',
    args: buildCodexArgs({ role, cwd, config }),
    cwd,
    stdin: prompt,
    onJson: (obj) => {
      for (const ev of parseCodexEvent(obj, st)) onEvent(ev);
      if (st.usageChanged) {
        st.usageChanged = false;
        onUsage({ ...st.usage });
      }
    },
    onText: (line) => onEvent({ kind: 'info', text: clip(line, 300) }),
  });
  const done = handle.done.then((r) => {
    if (r.error) return { ok: false, finalText: st.lastText, usage: st.usage, error: `Não foi possível iniciar o Codex: ${r.error}` };
    if (r.code !== 0 && !st.error) st.error = clip(r.stderr || `codex saiu com código ${r.code}`, 400);
    return { ok: !st.error, finalText: st.lastText, usage: st.usage, error: st.error };
  });
  return { done, kill: handle.kill };
}
