import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export async function detectObsidianVaultConfig(vaultRoot: string): Promise<Partial<CoreConfig>> {
  try {
    const appJsonPath = join(vaultRoot, '.obsidian', 'app.json');
    const content = await readFile(appJsonPath, 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const folderPath = typeof parsed.attachmentFolderPath === 'string' ? parsed.attachmentFolderPath.trim() : '';

    if (folderPath.includes('${filename}')) {
      const sanitized = folderPath.replaceAll('\\', '/').replace(/^\/+/u, '');
      const pattern = sanitized.replace('${filename}', '{note_name}');
      return {
        attachmentPattern: `{note_dir}/${pattern}/mermaid-{index}-{hash}.svg`,
        sourcePattern: `{note_dir}/${pattern}/mermaid-{index}-{hash}.mmd`
      };
    } else if (folderPath === './' || folderPath === '.') {
      return {
        attachmentPattern: '{note_dir}/mermaid-{index}-{hash}.svg',
        sourcePattern: '{note_dir}/mermaid-{index}-{hash}.mmd'
      };
    } else if (folderPath.startsWith('./')) {
      const sub = folderPath.slice(2).replaceAll('\\', '/').replace(/^\/+/u, '');
      return {
        attachmentPattern: `{note_dir}/${sub}/mermaid-{index}-{hash}.svg`,
        sourcePattern: `{note_dir}/${sub}/mermaid-{index}-{hash}.mmd`
      };
    } else if (folderPath.length > 0) {
      const clean = folderPath.replaceAll('\\', '/').replace(/^\/+/u, '');
      return {
        assetRoot: clean,
        attachmentPattern: `{asset_root}/{note_name}/mermaid-{index}-{hash}.svg`,
        sourcePattern: `{asset_root}/{note_name}/mermaid-{index}-{hash}.mmd`
      };
    }
  } catch {
    // Missing or invalid .obsidian/app.json falls back safely to defaults
  }
  return {};
}

interface RendererFileConfig {
  timeoutMs?: number;
  browserIdleTimeoutMs?: number;
  maxConcurrentRenders?: number;
  maxSourceBytes?: number;
  maxOutputBytes?: number;
  maxSvgBytes?: number;
  htmlLabels?: boolean;
  executablePath?: string;
  browserExecutablePath?: string;
}

interface WatcherFileConfig {
  enabled?: boolean;
  debounceMs?: number;
  apply?: boolean;
}

interface FileConfig extends Partial<CoreConfig> {
  renderer?: RendererFileConfig;
  watcher?: WatcherFileConfig;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export async function loadConfig(path?: string): Promise<CoreConfig> {
  if (!path) return { ...DEFAULT_CONFIG };
  const text = await readFile(path, 'utf8');
  const parsed = JSON.parse(text) as FileConfig;
  const renderer = parsed.renderer ?? {};
  const watcher = parsed.watcher ?? {};
  const browserExecutablePath = parsed.browserExecutablePath ?? renderer.browserExecutablePath ?? renderer.executablePath;
  return {
    ...DEFAULT_CONFIG,
    ...(parsed.vaultRoot ? { vaultRoot: parsed.vaultRoot } : {}),
    ...(browserExecutablePath ? { browserExecutablePath } : {}),
    assetRoot: parsed.assetRoot ?? DEFAULT_CONFIG.assetRoot,
    attachmentPattern: parsed.attachmentPattern ?? DEFAULT_CONFIG.attachmentPattern,
    sourcePattern: parsed.sourcePattern ?? DEFAULT_CONFIG.sourcePattern,
    embedWidth: parsed.embedWidth === null || typeof parsed.embedWidth === 'number' ? parsed.embedWidth : DEFAULT_CONFIG.embedWidth,
    theme: parsed.theme ?? DEFAULT_CONFIG.theme,
    background: parsed.background ?? DEFAULT_CONFIG.background,
    sourceStorage: parsed.sourceStorage ?? DEFAULT_CONFIG.sourceStorage,
    failurePolicy: parsed.failurePolicy ?? DEFAULT_CONFIG.failurePolicy,
    maxSourceBytes: finiteNumber(parsed.maxSourceBytes ?? renderer.maxSourceBytes, DEFAULT_CONFIG.maxSourceBytes),
    maxSvgBytes: finiteNumber(parsed.maxSvgBytes ?? renderer.maxOutputBytes ?? renderer.maxSvgBytes, DEFAULT_CONFIG.maxSvgBytes),
    renderTimeoutMs: finiteNumber(parsed.renderTimeoutMs ?? renderer.timeoutMs, DEFAULT_CONFIG.renderTimeoutMs),
    browserIdleTimeoutMs: finiteNumber(parsed.browserIdleTimeoutMs ?? renderer.browserIdleTimeoutMs, DEFAULT_CONFIG.browserIdleTimeoutMs),
    maxConcurrentRenders: finiteNumber(parsed.maxConcurrentRenders ?? renderer.maxConcurrentRenders, DEFAULT_CONFIG.maxConcurrentRenders),
    htmlLabels: parsed.htmlLabels ?? renderer.htmlLabels ?? DEFAULT_CONFIG.htmlLabels,
    watcherDebounceMs: finiteNumber(parsed.watcherDebounceMs ?? watcher.debounceMs, DEFAULT_CONFIG.watcherDebounceMs)
  };
}

export function mergeConfig(base: CoreConfig, overrides: Partial<CoreConfig>): CoreConfig {
  return { ...base, ...overrides };
}
