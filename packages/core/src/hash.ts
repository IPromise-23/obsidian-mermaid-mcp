import { createHash } from 'node:crypto';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeSource(source: string): string {
  return source.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '');
}

export function shortHash(value: string, length = 16): string {
  return sha256(value).slice(0, length);
}

export function renderHash(source: string, options: unknown): string {
  const value = (options && typeof options === 'object') ? options as Record<string, unknown> : {};
  // Keep operational knobs (timeouts and warning arrays) out of the cache
  // key; only rendering-affecting settings should create a new asset.
  const renderConfig = {
    theme: value.theme,
    themeContext: value.themeContext,
    background: value.background,
    htmlLabels: value.htmlLabels,
    securityLevel: value.securityLevel,
    renderer: value.renderer,
    rendererVersion: value.rendererVersion
  };
  return sha256(`${normalizeSource(source)}\u0000${JSON.stringify(renderConfig)}`);
}
