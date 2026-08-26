import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { CoreError } from './errors.js';
import { renderHash, sha256 } from './hash.js';
import { sanitizeSvg } from './svg.js';
import type { MermaidRenderer, RenderOptions, RenderedSvg, ResolvedRenderOptions } from './types.js';

export function resolveRenderOptions(options: RenderOptions): ResolvedRenderOptions {
  const warnings: string[] = [];
  if (!options.background || /(?:url\s*\(|javascript:|vbscript:|data:|[<>"'{};])/iu.test(options.background)) {
    throw new CoreError('INVALID_BACKGROUND', 'background must be a safe CSS color or transparent');
  }
  let theme: Exclude<RenderOptions['theme'], 'auto'> = options.theme === 'auto' ? 'default' : options.theme;
  if (options.theme === 'auto') {
    if (options.themeContext === 'dark') theme = 'dark';
    else if (options.themeContext !== 'light') warnings.push('theme=auto without themeContext falls back to default');
  }
  return { ...options, theme, warnings, securityLevel: 'strict' };
}

export function detectBrowserCandidates(configuredPath?: string): string[] {
  const envPath = configuredPath?.trim() ||
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
    process.env.CHROME_PATH?.trim() ||
    process.env.BROWSER_PATH?.trim();
  if (envPath) return [envPath];

  const list: Array<string | undefined> = [];

  // macOS candidates
  list.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Arc.app/Contents/MacOS/Arc'
  );

  // Linux candidates
  list.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/brave-browser'
  );

  // Windows candidates
  const progFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const progFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\AppData\\Local` : undefined);

  list.push(
    `${progFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${progFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
    localAppData ? `${localAppData}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    `${progFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${progFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${progFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    localAppData ? `${localAppData}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe` : undefined
  );

  return list.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

export class BrowserManager {
  private browser: unknown;
  private startPromise: Promise<unknown> | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly idleTimeoutMs = 300_000,
    private readonly executablePath?: string
  ) {}

  async get(): Promise<any> {
    if (this.closed) throw new CoreError('BROWSER_CLOSED', 'browser manager is closed');
    if (this.browser) {
      this.bumpIdleTimer();
      return this.browser;
    }
    if (!this.startPromise) {
      this.startPromise = (async () => {
        try {
          const puppeteer = await import('puppeteer');
          const launchOptions = {
            headless: true,
            args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox']
          };
          let launched;
          const candidates = detectBrowserCandidates(this.executablePath);
          let defaultPptrPath: string | undefined;
          try {
            defaultPptrPath = puppeteer.default.executablePath?.();
          } catch {
            defaultPptrPath = undefined;
          }
          const allCandidates: Array<string | undefined> = defaultPptrPath && existsSync(defaultPptrPath)
            ? [defaultPptrPath, ...candidates]
            : [...candidates, undefined];
          const errors: string[] = [];
          for (const executablePath of allCandidates) {
            if (executablePath !== undefined && !existsSync(executablePath)) continue;
            try {
              launched = await puppeteer.default.launch({
                ...launchOptions,
                ...(executablePath ? { executablePath } : {})
              });
              break;
            } catch (error) {
              errors.push(error instanceof Error ? error.message : String(error));
            }
          }
          if (!launched) throw new CoreError('BROWSER_START_FAILED', errors.join('\n--- browser launch attempt ---\n') || 'no usable browser executable was found');
          this.browser = launched;
          this.bumpIdleTimer();
          launched.on?.('disconnected', () => {
            this.browser = undefined;
          });
          return launched;
        } catch (error) {
          throw new CoreError('BROWSER_START_FAILED', error instanceof Error ? error.message : String(error));
        } finally {
          this.startPromise = undefined;
        }
      })();
    }
    return this.startPromise;
  }

  private bumpIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.closeBrowser();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private async closeBrowser(): Promise<void> {
    const current = this.browser as { close?: () => Promise<void> } | undefined;
    this.browser = undefined;
    if (current?.close) await current.close().catch(() => undefined);
  }

  /** Close an active browser after a cancelled or timed-out page render.
   * The manager remains reusable and will lazily start a fresh browser next time.
   */
  async interrupt(): Promise<void> {
    await this.closeBrowser();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    await this.closeBrowser();
  }
}

export class LocalMermaidRenderer implements MermaidRenderer {
  private readonly manager: BrowserManager;
  private queue: Promise<void> = Promise.resolve();

  constructor(idleTimeoutMs = 300_000, executablePath?: string) {
    this.manager = new BrowserManager(idleTimeoutMs, executablePath);
  }

  async render(source: string, options: RenderOptions, signal?: AbortSignal): Promise<RenderedSvg> {
    const resolved = resolveRenderOptions(options);
    const run = this.queue.then(async () => {
      if (signal?.aborted) throw new CoreError('RENDER_CANCELLED', 'render was cancelled');
      const browser = await this.manager.get();
      if (signal?.aborted) {
        await this.manager.interrupt();
        throw new CoreError('RENDER_CANCELLED', 'render was cancelled');
      }
      const cli = await import('@mermaid-js/mermaid-cli');
      if (signal?.aborted) {
        await this.manager.interrupt();
        throw new CoreError('RENDER_CANCELLED', 'render was cancelled');
      }
      const timeoutMs = options.timeoutMs ?? 30_000;
      const renderPromise = cli.renderMermaid(browser, source, 'svg', {
        backgroundColor: resolved.background === 'transparent' ? 'transparent' : resolved.background,
        mermaidConfig: {
          theme: resolved.theme,
          securityLevel: 'strict',
          htmlLabels: resolved.htmlLabels ?? false,
          startOnLoad: false
        }
      });
      let timer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;
      const cancellation = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CoreError('RENDER_TIMEOUT', `render exceeded ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
        abortHandler = () => reject(new CoreError('RENDER_CANCELLED', 'render was cancelled'));
        signal?.addEventListener('abort', abortHandler, { once: true });
      });
      let result;
      try {
        result = await Promise.race([renderPromise, cancellation]);
      } catch (error) {
        if (error instanceof CoreError && (error.code === 'RENDER_TIMEOUT' || error.code === 'RENDER_CANCELLED')) {
          await this.manager.interrupt();
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener('abort', abortHandler);
      }
      if (signal?.aborted) throw new CoreError('RENDER_CANCELLED', 'render was cancelled');
      const svg = sanitizeSvg(typeof result.data === 'string' ? result.data : Buffer.from(result.data).toString('utf8'));
      return {
        svg,
        renderer: 'mermaid-cli-node-api',
        rendererVersion: '11.16.0',
        sourceHash: sha256(source),
        renderHash: renderHash(source, resolved),
        warnings: resolved.warnings
      } satisfies RenderedSvg;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.manager.close();
  }
}

export class DeterministicRenderer implements MermaidRenderer {
  constructor(private readonly rendererName = 'deterministic-test-renderer') {}

  async render(source: string, options: RenderOptions): Promise<RenderedSvg> {
    const resolved = resolveRenderOptions(options);
    const sourceHash = sha256(source);
    const renderHashValue = renderHash(source, resolved);
    const escaped = source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 120"><rect width="800" height="120" fill="${resolved.background === 'transparent' ? 'none' : resolved.background}"/><text x="16" y="36" font-family="sans-serif" font-size="16">Mermaid preview</text><text x="16" y="68" font-family="monospace" font-size="12">${escaped.slice(0, 180)}</text></svg>`;
    return { svg, renderer: this.rendererName, rendererVersion: 'test', sourceHash, renderHash: renderHashValue, warnings: resolved.warnings };
  }
}
