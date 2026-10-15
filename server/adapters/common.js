import path from 'node:path';

export const READ_ONLY_ROLES = new Set(['revisar', 'auditar', 'planejar', 'analisar']);

export const base = (p) => (p ? path.basename(String(p)) : '');

export const clip = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
};

export const emptyUsage = () => ({ input: 0, cachedInput: 0, output: 0, costUsd: 0 });
