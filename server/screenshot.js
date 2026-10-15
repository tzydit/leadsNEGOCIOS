import fs from 'node:fs';
import path from 'node:path';

// Tamanhos padrão. deviceScaleFactor 1 para as imagens não custarem tokens à toa.
export const SIZES = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180, isMobile: true, hasTouch: true },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
};
const MAX_FULL_HEIGHT = 6000;

export function checkUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`URL inválida: ${url}`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Só dá para capturar endereços http:// ou https://');
  return u.href;
}

export const safeName = (n) => String(n || 'captura').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'captura';

export function parseSizes(list) {
  const sizes = String(list || 'desktop,mobile').split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of sizes) if (!SIZES[s]) throw new Error(`Tamanho desconhecido: ${s} (use desktop, tablet, mobile)`);
  return [...new Set(sizes)];
}

/**
 * Abre o navegador: caminho configurado → Google Chrome instalado → Microsoft
 * Edge → Chromium do Playwright (se existir). Nada é baixado.
 */
export async function launchBrowser(chromePath = process.env.CHROME_PATH) {
  const { chromium } = await import('playwright-core');
  const tries = [];
  if (chromePath) tries.push(['caminho configurado', { executablePath: chromePath }]);
  tries.push(['Google Chrome', { channel: 'chrome' }], ['Microsoft Edge', { channel: 'msedge' }], ['Chromium do Playwright', {}]);
  const errors = [];
  for (const [via, opts] of tries) {
    try {
      const browser = await chromium.launch({ headless: true, ...opts });
      return { browser, via };
    } catch (err) {
      errors.push(`${via}: ${String(err.message).split('\n')[0]}`);
    }
  }
  throw new Error(`Nenhum navegador encontrado. Instale o Google Chrome ou informe o caminho em CHROME_PATH / Configurações.\n${errors.join('\n')}`);
}

/** Captura a página em cada tamanho e devolve os arquivos e os erros vistos no console. */
export async function capture({ url, outDir, name = 'captura', sizes = ['desktop', 'mobile'], full = false, waitMs = 800, theme = null, chromePath, timeoutMs = 30000 }) {
  const href = checkUrl(url);
  fs.mkdirSync(outDir, { recursive: true });
  const { browser, via } = await launchBrowser(chromePath);
  const files = [];
  const problems = new Set();
  try {
    for (const size of sizes) {
      const spec = SIZES[size];
      const ctx = await browser.newContext({
        viewport: { width: spec.width, height: spec.height },
        isMobile: Boolean(spec.isMobile),
        hasTouch: Boolean(spec.hasTouch),
        deviceScaleFactor: 1,
        colorScheme: theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'no-preference',
      });
      const page = await ctx.newPage();
      page.on('console', (m) => m.type() === 'error' && problems.add(`console: ${m.text().slice(0, 200)}`));
      page.on('pageerror', (e) => problems.add(`erro de JS: ${String(e.message).slice(0, 200)}`));
      page.on('requestfailed', (r) => problems.add(`falhou ao carregar: ${r.url().slice(0, 160)}`));
      page.on('response', (r) => r.status() >= 400 && problems.add(`HTTP ${r.status()}: ${r.url().slice(0, 160)}`));
      try {
        await page.goto(href, { waitUntil: 'networkidle', timeout: timeoutMs });
      } catch (err) {
        if (!/Timeout/i.test(err.message)) throw new Error(`Não abriu ${href}: ${String(err.message).split('\n')[0]}`);
        problems.add('a página não ficou ociosa a tempo (capturada mesmo assim)');
      }
      await page.waitForTimeout(waitMs);
      const file = path.join(outDir, `${safeName(name)}-${size}.png`);
      let height = spec.height;
      if (full) {
        const total = await page.evaluate(() => document.documentElement.scrollHeight);
        height = Math.min(total, MAX_FULL_HEIGHT);
        await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: spec.width, height } });
      } else {
        await page.screenshot({ path: file });
      }
      // overflow horizontal é um defeito de layout comum, principalmente no celular
      const overflow = (await page.evaluate(() => document.documentElement.scrollWidth)) - spec.width;
      if (overflow > 1) problems.add(`rolagem horizontal de ${overflow}px em ${size}`);
      files.push({ size, path: file, width: spec.width, height });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return { files, problems: [...problems].slice(0, 12), via };
}
