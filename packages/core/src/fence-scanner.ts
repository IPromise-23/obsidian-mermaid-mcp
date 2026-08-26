import type { FenceBlock, ManagedBlock, ManagedMarker } from './types.js';

interface SourceLine {
  start: number;
  end: number;
  text: string;
  newline: '\n' | '\r\n' | '';
}

function linesOf(content: string): SourceLine[] {
  const result: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      const hasCr = index > 0 && content[index - 1] === '\r';
      const textEnd = hasCr ? index - 1 : index;
      result.push({ start, end: index + 1, text: content.slice(start, textEnd), newline: hasCr ? '\r\n' : '\n' });
      start = index + 1;
    }
  }
  if (start < content.length) result.push({ start, end: content.length, text: content.slice(start), newline: '' });
  if (content.length === 0) result.push({ start: 0, end: 0, text: '', newline: '' });
  return result;
}

function containerOf(line: string): { prefix: string; rest: string } {
  const match = line.match(/^((?: {0,3}>[ \t]?)+)(.*)$/u);
  if (match?.[1] !== undefined && match[2] !== undefined) return { prefix: match[1], rest: match[2] };
  const indent = line.match(/^( {0,3})(.*)$/u);
  return { prefix: indent?.[1] ?? '', rest: indent?.[2] ?? line };
}

function normalizeInfo(info: string): string {
  return info.trim().replace(/[ \t]+/gu, ' ');
}

function isMermaidInfo(info: string): boolean {
  const first = normalizeInfo(info).split(' ')[0]?.toLowerCase() ?? '';
  return first === 'mermaid';
}

function parseMarker(line: string): { prefix: string; marker: ManagedMarker } | undefined {
  const match = line.match(/^((?: {0,3}>[ \t]?)*(?: {0,3})?)(?:<!--\s*obsidian-mermaid-mcp:v1\s+(.+?)\s*-->)\s*$/u);
  if (!match?.[2]) return undefined;
  try {
    const parsed = JSON.parse(match[2]) as ManagedMarker;
    if (parsed.version !== 1 || typeof parsed.id !== 'string' || typeof parsed.svg !== 'string' || typeof parsed.hash !== 'string') return undefined;
    return { prefix: match[1] ?? '', marker: parsed };
  } catch {
    return undefined;
  }
}

export interface ScanResult {
  fences: FenceBlock[];
  managed: ManagedBlock[];
}

export function scanMarkdown(content: string): ScanResult {
  const lines = linesOf(content);
  const fences: FenceBlock[] = [];
  const managed: ManagedBlock[] = [];
  let fence: {
    lineIndex: number;
    start: SourceLine;
    char: '`' | '~';
    length: number;
    info: string;
    containerPrefix: string;
    indent: string;
  } | undefined;
  let index = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line) continue;
    const parsed = containerOf(line.text);
    const opener = parsed.rest.match(/^( {0,3})(`{3,}|~{3,})(.*)$/u);
    if (!fence && opener) {
      const char = opener[2]?.[0] as '`' | '~' | undefined;
      const run = opener[2] ?? '';
      if (char && isMermaidInfo(opener[3] ?? '')) {
        fence = {
          lineIndex,
          start: line,
          char,
          length: run.length,
          info: normalizeInfo(opener[3] ?? ''),
          containerPrefix: parsed.prefix,
          indent: opener[1] ?? ''
        };
      } else if (char) {
        // Track non-Mermaid fences only enough to avoid treating their contents as openers.
        fence = {
          lineIndex,
          start: line,
          char,
          length: run.length,
          info: '',
          containerPrefix: parsed.prefix,
          indent: opener[1] ?? ''
        };
      }
      continue;
    }
    if (fence) {
      // A malformed ordinary fence should not swallow a later Mermaid fence
      // that uses the other fence character. Recover at that boundary while
      // keeping valid same-character fences stateful.
      const recovery = parsed.rest.match(/^( {0,3})(`{3,}|~{3,})(.*)$/u);
      if (!fence.info && recovery && recovery[2]?.[0] !== fence.char && isMermaidInfo(recovery[3] ?? '')) {
        const recoveredChar = recovery[2]?.[0] as '`' | '~';
        fence = {
          lineIndex,
          start: line,
          char: recoveredChar,
          length: recovery[2]?.length ?? 3,
          info: normalizeInfo(recovery[3] ?? ''),
          containerPrefix: parsed.prefix,
          indent: recovery[1] ?? ''
        };
        continue;
      }
    }
    if (fence) {
      const closing = parsed.rest.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/u);
      if (closing && closing[2]?.[0] === fence.char && (closing[2]?.length ?? 0) >= fence.length) {
        if (fence.info) {
          const bodyLines = lines.slice(fence.lineIndex + 1, lineIndex);
          const source = bodyLines
            .map((body) => {
              let text = body.text;
              if (fence?.containerPrefix && text.startsWith(fence.containerPrefix)) text = text.slice(fence.containerPrefix.length);
              if (fence?.indent && text.startsWith(fence.indent)) text = text.slice(fence.indent.length);
              return text;
            })
            .join('\n');
          const raw = content.slice(fence.start.start, line.end);
          const newline = fence.start.newline === '\r\n' || bodyLines.some((entry) => entry.newline === '\r\n') ? '\r\n' : '\n';
          fences.push({
            kind: 'fence', index: index++, start: fence.start.start, end: line.end,
            startLine: fence.lineIndex + 1, endLine: lineIndex + 1,
            fenceChar: fence.char, fenceLength: fence.length, info: fence.info,
            source, prefix: `${fence.containerPrefix}${fence.indent}`, containerPrefix: fence.containerPrefix,
            newline, raw
          });
        }
        fence = undefined;
      }
      continue;
    }
    const marker = parseMarker(line.text);
    const next = lines[lineIndex + 1];
    if (marker && next) {
      const nextText = next.text;
      const expected = `${marker.prefix}![[`;
      if (nextText.startsWith(expected) && nextText.includes(']]')) {
        managed.push({
          kind: 'managed', index: index++, start: line.start, end: next.end,
          startLine: lineIndex + 1, endLine: lineIndex + 2,
          marker: marker.marker, embed: nextText.slice(marker.prefix.length), prefix: marker.prefix,
          raw: content.slice(line.start, next.end)
        });
        lineIndex += 1;
      }
    }
  }
  return { fences, managed };
}

export function applyReplacements(content: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  return [...replacements]
    .sort((a, b) => b.start - a.start)
    .reduce((result, replacement) => result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end), content);
}

export function managedMarkerLine(marker: ManagedMarker): string {
  return `<!-- obsidian-mermaid-mcp:v1 ${JSON.stringify(marker)} -->`;
}
