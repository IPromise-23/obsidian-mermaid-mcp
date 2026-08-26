import { DOMParser, XMLSerializer, type Document } from '@xmldom/xmldom';
import { Buffer } from 'node:buffer';
import { CoreError } from './errors.js';
import { sha256 } from './hash.js';

const METADATA_NS = 'https://github.com/obsidian-mermaid-mcp/schema/v1';

export interface SvgMetadata {
  version: 1;
  id: string;
  sourceHash: string;
  source: string;
  sidecarPath?: string;
  notePath?: string;
  fence?: {
    char: '`' | '~';
    length: number;
    info: string;
    prefix: string;
    containerPrefix: string;
    newline: '\n' | '\r\n';
    trailingNewline?: boolean;
  };
  theme: string;
  themeContext?: 'light' | 'dark';
  background: string;
  renderer: string;
  rendererVersion: string;
}

function errorHandler(level: string, message: string): void {
  if (level === 'error' || level === 'fatalError') throw new CoreError('SVG_SANITIZE_FAILED', message);
}

function parseSvg(svg: string): Document {
  if (/<!doctype\b|<!entity\b/iu.test(svg)) throw new CoreError('SVG_SANITIZE_FAILED', 'DOCTYPE and ENTITY are not allowed in SVG');
  const parser = new DOMParser({ errorHandler });
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') throw new CoreError('SVG_SANITIZE_FAILED', 'SVG root element is missing');
  return doc;
}

function cssValues(svg: string): string[] {
  const values: string[] = [];
  for (const match of svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)) {
    if (match[1] !== undefined) values.push(match[1]);
  }
  for (const match of svg.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return values;
}

function assertSafeCss(svg: string): void {
  for (const css of cssValues(svg)) {
    if (/@import\b/iu.test(css)) {
      throw new CoreError('SVG_SANITIZE_FAILED', 'external CSS imports are not allowed in SVG');
    }
    for (const match of css.matchAll(/url\s*\(\s*(["']?)(.*?)\1\s*\)/giu)) {
      const value = (match[2] ?? '').trim();
      if (value.startsWith('#') || /^data:image\/(?:png|gif|jpeg|webp);base64,/iu.test(value)) continue;
      throw new CoreError('SVG_SANITIZE_FAILED', 'external CSS URLs are not allowed in SVG');
    }
  }
}

function stripDangerous(svg: string): string {
  let clean = svg;
  assertSafeCss(clean);
  clean = clean.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, '');
  clean = clean.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/giu, '');
  clean = clean.replace(/<(?:iframe|object|embed|audio|video)\b[^>]*>[\s\S]*?(?:<\/[^>]+>|\/?>)/giu, '');
  clean = clean.replace(/\s+on[a-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '');
  clean = clean.replace(/\s+(?:href|xlink:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu, (full, a: string | undefined, b: string | undefined, c: string | undefined) => {
    const value = (a ?? b ?? c ?? '').trim();
    if (value.startsWith('#') || /^data:image\/(?:png|gif|jpeg|webp);base64,/iu.test(value)) return full;
    return '';
  });
  clean = clean.replace(/<use\b[^>]*?(?:href|xlink:href)\s*=\s*["'](?:https?:|\/\/|javascript:)[^>]*>/giu, '');
  return clean;
}

export function sanitizeSvg(svg: string, maxBytes = 8_388_608): string {
  if (Buffer.byteLength(svg, 'utf8') > maxBytes) throw new CoreError('SVG_TOO_LARGE', 'rendered SVG exceeds the configured size limit');
  const clean = stripDangerous(svg);
  const doc = parseSvg(clean);
  const serialized = new XMLSerializer().serializeToString(doc);
  assertSafeCss(serialized);
  if (/\b(?:javascript|vbscript):/iu.test(serialized) || /<script\b/iu.test(serialized)) {
    throw new CoreError('SVG_SANITIZE_FAILED', 'unsafe content remains after SVG sanitization');
  }
  return serialized;
}

function encodeSource(source: string): string {
  return Buffer.from(source, 'utf8').toString('base64');
}

function decodeSource(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

export function injectMetadata(svg: string, metadata: SvgMetadata, maxBytes = 8_388_608): string {
  const clean = sanitizeSvg(svg, maxBytes);
  const payload = encodeSource(JSON.stringify(metadata));
  const metadataXml = `<metadata><mcp-mermaid:source xmlns:mcp-mermaid="${METADATA_NS}" encoding="base64" sha256="${sha256(metadata.source)}">${payload}</mcp-mermaid:source></metadata>`;
  const withoutOld = clean.replace(/<metadata>\s*<mcp-mermaid:source\b[\s\S]*?<\/mcp-mermaid:source>\s*<\/metadata>/giu, '');
  const match = withoutOld.match(/^([\s\S]*?<svg\b[^>]*>)/iu);
  if (!match) throw new CoreError('SVG_SANITIZE_FAILED', 'cannot locate SVG root for metadata injection');
  const rootOpen = match[1] ?? '';
  const result = `${rootOpen}${metadataXml}${withoutOld.slice(rootOpen.length)}`;
  if (Buffer.byteLength(result, 'utf8') > maxBytes) throw new CoreError('SVG_TOO_LARGE', 'SVG with metadata exceeds the configured size limit');
  return result;
}

export function readMetadata(svg: string): SvgMetadata | undefined {
  const clean = sanitizeSvg(svg);
  const match = clean.match(/<mcp-mermaid:source\b[^>]*encoding=["']base64["'][^>]*>([A-Za-z0-9+/=\s]+)<\/mcp-mermaid:source>/iu);
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(decodeSource(match[1].replace(/\s+/gu, ''))) as SvgMetadata;
    if (parsed.version !== 1 || typeof parsed.source !== 'string' || typeof parsed.sourceHash !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
