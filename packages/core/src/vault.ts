import { lstat, readFile, stat } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { atomicWrite } from './atomic-writer.js';
import { detectObsidianVaultConfig } from './config.js';
import { CoreError, asStructuredError } from './errors.js';
import { applyReplacements, managedMarkerLine, scanMarkdown } from './fence-scanner.js';
import { normalizeSource, renderHash, sha256, shortHash } from './hash.js';
import { assertInside, assertNoSymlinkEscape, assertRelativeVaultPath, expandTemplate, resolveVaultRoot, safeNoteName } from './path-policy.js';
import { LocalMermaidRenderer, resolveRenderOptions } from './renderer.js';
import { injectMetadata, readMetadata, sanitizeSvg, type SvgMetadata } from './svg.js';
import type {
  AssetPlan, CoreConfig, FenceBlock, ManagedBlock, ManagedMarker, MermaidRenderer, RenderOptions, RenderedSvg,
  RestoreResult, StructuredError, SyncResult, NoteFingerprint
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export interface SyncOptions {
  apply?: boolean;
  blockIds?: string[];
  expectedHash?: string;
  theme?: RenderOptions['theme'];
  themeContext?: RenderOptions['themeContext'];
  background?: RenderOptions['background'];
  embedWidth?: number | null;
  signal?: AbortSignal;
}

export interface RestoreOptions {
  apply?: boolean;
  expectedHash?: string;
  signal?: AbortSignal;
}

export interface ExtractOptions {
  notePath?: string;
  svgPath?: string;
}

export class VaultService {
  config: CoreConfig;
  private readonly rawConfig: Partial<CoreConfig>;
  private readonly renderer: MermaidRenderer;
  private readonly ownedRenderer: LocalMermaidRenderer | undefined;
  private root: string | undefined;
  private readonly noteQueues = new Map<string, Promise<void>>();

  constructor(vaultRoot: string | undefined, config: Partial<CoreConfig> = {}, renderer?: MermaidRenderer) {
    this.rawConfig = config;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.renderer = renderer ?? new LocalMermaidRenderer(this.config.browserIdleTimeoutMs, this.config.browserExecutablePath);
    this.ownedRenderer = renderer ? undefined : (this.renderer as LocalMermaidRenderer);
    this.root = vaultRoot;
  }

  async initialize(): Promise<void> {
    if (this.root) {
      this.root = await resolveVaultRoot(this.root);
      if (!this.rawConfig.attachmentPattern && !this.rawConfig.sourcePattern) {
        const detected = await detectObsidianVaultConfig(this.root);
        this.config = { ...this.config, ...detected };
      }
    }
  }

  async close(): Promise<void> {
    await this.ownedRenderer?.close();
  }

  private requireRoot(): string {
    if (!this.root) throw new CoreError('VAULT_ROOT_REQUIRED', 'a vault root is required for file operations');
    return this.root;
  }

  private async noteAbsolute(notePath: string): Promise<{ relative: string; absolute: string }> {
    let root = this.requireRoot();
    root = await resolveVaultRoot(root);
    this.root = root;
    const relative = assertRelativeVaultPath(notePath, 'notePath');
    if (!relative.toLowerCase().endsWith('.md')) throw new CoreError('INVALID_NOTE_PATH', 'notePath must end in .md');
    const absolute = assertInside(root, join(root, relative));
    await assertNoSymlinkEscape(root, absolute);
    const noteStat = await lstat(absolute);
    if (!noteStat.isFile()) throw new CoreError('INVALID_NOTE_PATH', 'notePath is not a regular file');
    return { relative, absolute };
  }

  private async pathAbsolute(relativePath: string): Promise<string> {
    let root = this.requireRoot();
    root = await resolveVaultRoot(root);
    this.root = root;
    const relative = assertRelativeVaultPath(relativePath);
    const absolute = assertInside(root, join(root, relative));
    await assertNoSymlinkEscape(root, absolute);
    return absolute;
  }

  private async fingerprint(path: string): Promise<NoteFingerprint> {
    const [metadata, content] = await Promise.all([stat(path), readFile(path)]);
    return { sha256: sha256(content), size: metadata.size, mtimeMs: metadata.mtimeMs };
  }

  private renderOptions(options: SyncOptions): RenderOptions {
    return {
      theme: options.theme ?? this.config.theme,
      themeContext: options.themeContext,
      background: options.background ?? this.config.background,
      htmlLabels: this.config.htmlLabels,
      securityLevel: 'strict',
      timeoutMs: this.config.renderTimeoutMs
    };
  }

  private enqueueNote<T>(notePath: string, task: () => Promise<T>): Promise<T> {
    const previous = this.noteQueues.get(notePath) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.then(() => undefined, () => undefined);
    this.noteQueues.set(notePath, tail);
    void tail.then(() => {
      if (this.noteQueues.get(notePath) === tail) this.noteQueues.delete(notePath);
    });
    return run;
  }

  private assetPaths(notePath: string, index: number, sourceHash: string, blockId: string): { svg: string; source: string } {
    const values = {
      asset_root: this.config.assetRoot,
      note_name: safeNoteName(notePath),
      note_path: notePath,
      note_dir: notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '',
      index: String(index).padStart(3, '0'),
      block_id: blockId,
      hash: sourceHash.slice(0, 16),
      ext: 'svg'
    };
    const svg = expandTemplate(this.config.attachmentPattern, values);
    const source = expandTemplate(this.config.sourcePattern, { ...values, ext: 'mmd' });
    if (!svg.includes(values.hash) && !svg.includes(blockId)) throw new CoreError('INVALID_TEMPLATE', 'SVG template must include {hash} or {block_id}');
    if (!source.includes(values.hash) && !source.includes(blockId)) throw new CoreError('INVALID_TEMPLATE', 'source template must include {hash} or {block_id}');
    return { svg, source };
  }

  private managedReplacement(block: FenceBlock, marker: ManagedMarker, width: number | null): string {
    const embed = width === null ? `![[${marker.svg}]]` : `![[${marker.svg}|${width}]]`;
    const newline = block.newline;
    const prefix = block.prefix;
    const suffix = block.raw.endsWith(newline) ? newline : '';
    return `${prefix}${embed}${suffix}`;
  }

  private async cachedRendered(svgPath: string, sourceHash: string, expectedRenderHash: string): Promise<RenderedSvg | undefined> {
    try {
      const svg = await readFile(await this.pathAbsolute(svgPath), 'utf8');
      const metadata = readMetadata(svg);
      if (!metadata || metadata.sourceHash !== sourceHash || renderHash(metadata.source, {
        theme: metadata.theme,
        themeContext: metadata.themeContext,
        background: metadata.background,
        securityLevel: 'strict',
        htmlLabels: this.config.htmlLabels,
        warnings: []
      }) !== expectedRenderHash) return undefined;
      return {
        svg,
        renderer: metadata.renderer,
        rendererVersion: metadata.rendererVersion,
        sourceHash,
        renderHash: expectedRenderHash,
        warnings: []
      };
    } catch {
      return undefined;
    }
  }

  private async readManagedSource(marker: ManagedMarker): Promise<{ source?: string; sourcePath?: string; sourceHash?: string; error?: StructuredError; fence?: ManagedMarker['fence'] }> {
    let sourcePath = marker.source;
    let fence = marker.fence;
    let sourceHash = marker.hash;
    let meta: SvgMetadata | undefined;
    try {
      const svg = await readFile(await this.pathAbsolute(marker.svg), 'utf8');
      meta = readMetadata(svg);
      if (meta) {
        if (!sourcePath && meta.sidecarPath) sourcePath = meta.sidecarPath;
        if (!fence && meta.fence) fence = meta.fence;
        if (meta.sourceHash) sourceHash = meta.sourceHash;
      }
    } catch {
      // SVG read failed
    }
    if (sourcePath) {
      try {
        const sidecarText = await readFile(await this.pathAbsolute(sourcePath), 'utf8');
        return { source: normalizeSource(sidecarText), sourcePath, sourceHash, fence };
      } catch {
        // Fall through to the self-contained SVG metadata.
      }
    }
    if (meta?.source !== undefined) {
      return { source: meta.source, sourcePath, sourceHash: meta.sourceHash, fence };
    }
    return { sourcePath: marker.source, error: { code: 'SOURCE_NOT_FOUND', message: 'managed block has no readable sidecar or SVG metadata', path: marker.svg } };
  }

  async extract(options: ExtractOptions): Promise<Record<string, unknown>> {
    if (options.svgPath) {
      const svgPath = assertRelativeVaultPath(options.svgPath, 'svgPath');
      const svg = await readFile(await this.pathAbsolute(svgPath), 'utf8');
      const metadata = readMetadata(svg);
      if (!metadata) throw new CoreError('SOURCE_NOT_FOUND', 'SVG metadata does not contain Mermaid source');
      return { source: metadata.source, sourceHash: metadata.sourceHash, metadata, svgPath };
    }
    if (!options.notePath) throw new CoreError('INVALID_PARAMS', 'notePath or svgPath is required');
    const note = await this.noteAbsolute(options.notePath);
    const content = await readFile(note.absolute, 'utf8');
    const scanned = scanMarkdown(content);
    const managed = await Promise.all(scanned.managed.map(async (block) => {
      const recovered = await this.readManagedSource(block.marker);
      return {
        ...block,
        raw: undefined,
        source: recovered.source,
        sourcePath: recovered.sourcePath,
        sourceHash: block.marker.hash,
        status: recovered.source === undefined ? 'missing' : 'available',
        error: recovered.error
      };
    }));
    return {
      notePath: note.relative,
      fingerprint: await this.fingerprint(note.absolute),
      fences: scanned.fences.map((block) => ({ ...block, raw: undefined })),
      managed
    };
  }

  async render(source: string, options: Partial<RenderOptions> = {}, signal?: AbortSignal): Promise<RenderedSvg> {
    if (!source || Buffer.byteLength(source, 'utf8') > this.config.maxSourceBytes) throw new CoreError('SOURCE_TOO_LARGE', 'Mermaid source is empty or exceeds the configured limit');
    const rendered = await this.renderer.render(source, {
      theme: options.theme ?? this.config.theme,
      themeContext: options.themeContext,
      background: options.background ?? this.config.background,
      htmlLabels: options.htmlLabels ?? this.config.htmlLabels,
      securityLevel: 'strict',
      timeoutMs: options.timeoutMs ?? this.config.renderTimeoutMs
    }, signal);
    if (Buffer.byteLength(rendered.svg, 'utf8') > this.config.maxSvgBytes) throw new CoreError('SVG_TOO_LARGE', 'rendered SVG exceeds the configured size limit');
    return rendered;
  }

  async sync(notePath: string, options: SyncOptions = {}): Promise<SyncResult> {
    return this.enqueueNote(notePath, () => this.syncInternal(notePath, options));
  }

  private async syncInternal(notePath: string, options: SyncOptions = {}): Promise<SyncResult> {
    const note = await this.noteAbsolute(notePath);
    const apply = options.apply === true;
    const initial = await this.fingerprint(note.absolute);
    if (options.expectedHash && options.expectedHash !== initial.sha256) {
      return { operation: 'sync_note', notePath: note.relative, apply, changed: false, conflict: true, blocks: [], errors: [{ code: 'CONCURRENT_MODIFICATION', message: 'expectedHash does not match current note', path: note.relative }], warnings: [] };
    }
    const content = await readFile(note.absolute, 'utf8');
    const scanned = scanMarkdown(content);
    const plans: AssetPlan[] = [];
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    const artifacts: Array<{ svgPath: string; sourcePath: string; svg: string; source: string }> = [];
    const errors: StructuredError[] = [];
    const warnings: string[] = [];
    const renderOptions = this.renderOptions(options);
    const resolvedRenderOptions = resolveRenderOptions(renderOptions);
    for (const block of scanned.fences) {
      if (options.signal?.aborted) throw new CoreError('RENDER_CANCELLED', 'render was cancelled');
      const source = normalizeSource(block.source);
      const id = `mm-${shortHash(`${note.relative}:${block.index}:${source}`, 12)}`;
      if (options.blockIds && !options.blockIds.includes(id)) continue;
      try {
        if (Buffer.byteLength(source, 'utf8') > this.config.maxSourceBytes) throw new CoreError('SOURCE_TOO_LARGE', 'Mermaid source exceeds the configured limit');
        const sourceHash = sha256(source);
        const provisional = this.assetPaths(note.relative, block.index + 1, sourceHash, id);
        const expectedRenderHash = renderHash(source, resolvedRenderOptions);
        let rendered = await this.cachedRendered(provisional.svg, sourceHash, expectedRenderHash);
        const status: AssetPlan['status'] = rendered ? 'cached' : 'new';
        if (!rendered) rendered = await this.render(source, renderOptions, options.signal);
        const metadata: SvgMetadata = {
          version: 1, id, sourceHash, source, sidecarPath: provisional.source,
          notePath: note.relative,
          fence: {
            char: block.fenceChar, length: block.fenceLength, info: block.info,
            prefix: block.prefix, containerPrefix: block.containerPrefix, newline: block.newline,
            trailingNewline: block.raw.endsWith(block.newline)
          },
          theme: resolvedRenderOptions.theme, themeContext: resolvedRenderOptions.themeContext,
          background: resolvedRenderOptions.background,
          renderer: rendered.renderer, rendererVersion: rendered.rendererVersion
        };
        const svg = injectMetadata(rendered.svg, metadata, this.config.maxSvgBytes);
        const marker: ManagedMarker = {
          version: 1, id, svg: provisional.svg, source: provisional.source, hash: sourceHash, note: note.relative,
          fence: metadata.fence
        };
        const replacement = this.managedReplacement(block, marker, options.embedWidth ?? this.config.embedWidth);
        replacements.push({ start: block.start, end: block.end, value: replacement });
        plans.push({ id, index: block.index + 1, svgPath: provisional.svg, sourcePath: provisional.source, sourceHash, renderHash: rendered.renderHash, embed: replacement.trim(), status, warnings: rendered.warnings });
        artifacts.push({ svgPath: provisional.svg, sourcePath: provisional.source, svg, source });
        warnings.push(...rendered.warnings);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const structured = asStructuredError(error, 'MERMAID_PARSE_ERROR');
        structured.blockId = id;
        errors.push(structured);
        plans.push({ id, index: block.index + 1, svgPath: '', sourcePath: '', sourceHash: sha256(source), renderHash: '', embed: '', status: 'failed', error: structured, warnings: [] });
      }
    }
    // A managed block may have been edited on a mobile device through its
    // sidecar. Re-render that source and keep the managed marker reversible.
    for (const managed of scanned.managed) {
      try {
        if (options.signal?.aborted) throw new CoreError('RENDER_CANCELLED', 'render was cancelled');
        const recovered = await this.readManagedSource(managed.marker);
        if (!recovered.source) continue;
        const sidecar = normalizeSource(recovered.source);
        const sourceHash = sha256(sidecar);
        const knownHash = recovered.sourceHash ?? managed.marker.hash;
        const isLegacyComment = managed.raw.includes('<!--');
        const hashMatches = sourceHash === knownHash || sourceHash.startsWith(knownHash) || knownHash.startsWith(sourceHash);
        if (hashMatches) {
          if (isLegacyComment) {
            const newline = recovered.fence?.newline ?? '\n';
            const prefix = managed.prefix;
            const embed = this.config.embedWidth === null ? `![[${managed.marker.svg}]]` : `![[${managed.marker.svg}|${this.config.embedWidth}]]`;
            const suffix = managed.raw.endsWith(newline) ? newline : '';
            const replacement = `${prefix}${embed}${suffix}`;
            replacements.push({ start: managed.start, end: managed.end, value: replacement });
            plans.push({
              id: managed.marker.id,
              index: managed.index + 1,
              svgPath: managed.marker.svg,
              sourcePath: recovered.sourcePath ?? '',
              sourceHash,
              renderHash: '',
              embed: replacement.trim(),
              status: 'unchanged',
              warnings: []
            });
            continue;
          }
          plans.push({
            id: managed.marker.id,
            index: managed.index + 1,
            svgPath: managed.marker.svg,
            sourcePath: recovered.sourcePath ?? '',
            sourceHash,
            renderHash: '',
            embed: managed.embed,
            status: 'unchanged',
            warnings: []
          });
          continue;
        }
        const id = managed.marker.id;
        const provisional = this.assetPaths(note.relative, managed.index + 1, sourceHash, id);
        const rendered = await this.render(sidecar, renderOptions, options.signal);
        const fence = recovered.fence ?? managed.marker.fence ?? { char: '`' as const, length: 3, info: 'mermaid', prefix: managed.prefix, containerPrefix: managed.prefix, newline: '\n' as const };
        const metadata: SvgMetadata = {
          version: 1, id, sourceHash, source: sidecar, sidecarPath: provisional.source,
          notePath: note.relative, fence, theme: resolvedRenderOptions.theme,
          themeContext: resolvedRenderOptions.themeContext, background: resolvedRenderOptions.background,
          renderer: rendered.renderer, rendererVersion: rendered.rendererVersion
        };
        const svg = injectMetadata(rendered.svg, metadata, this.config.maxSvgBytes);
        const marker: ManagedMarker = { ...managed.marker, hash: sourceHash, svg: provisional.svg, source: provisional.source, fence };
        const newline = fence.newline;
        const prefix = managed.prefix;
        const embed = this.config.embedWidth === null ? `![[${marker.svg}]]` : `![[${marker.svg}|${this.config.embedWidth}]]`;
        const suffix = managed.raw.endsWith(newline) ? newline : '';
        const replacement = `${prefix}${embed}${suffix}`;
        replacements.push({ start: managed.start, end: managed.end, value: replacement });
        plans.push({ id, index: managed.index + 1, svgPath: provisional.svg, sourcePath: provisional.source, sourceHash, renderHash: rendered.renderHash, embed: replacement.trim(), status: 'new', warnings: rendered.warnings });
        artifacts.push({ svgPath: provisional.svg, sourcePath: provisional.source, svg, source: sidecar });
        warnings.push(...rendered.warnings);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const structured = asStructuredError(error, 'MERMAID_PARSE_ERROR');
        structured.blockId = managed.marker.id;
        errors.push(structured);
      }
    }
    if (this.config.failurePolicy === 'all_or_nothing' && errors.length > 0) replacements.length = 0;
    const transformedContent = replacements.length ? applyReplacements(content, replacements) : content;
    if (!apply || errors.length > 0 && this.config.failurePolicy === 'all_or_nothing') {
      return { operation: 'sync_note', notePath: note.relative, apply, changed: transformedContent !== content, conflict: false, blocks: plans, transformedContent, errors, warnings };
    }
    if (options.signal?.aborted) throw new CoreError('RENDER_CANCELLED', 'render was cancelled');
    const beforeCommit = await this.fingerprint(note.absolute);
    if (beforeCommit.sha256 !== initial.sha256 || beforeCommit.size !== initial.size || beforeCommit.mtimeMs !== initial.mtimeMs) {
      return { operation: 'sync_note', notePath: note.relative, apply, changed: false, conflict: true, blocks: plans, errors: [...errors, { code: 'CONCURRENT_MODIFICATION', message: 'note changed while rendering', path: note.relative }], warnings };
    }
    const root = this.requireRoot();
    try {
      for (const artifact of artifacts) {
        if (options.signal?.aborted) throw new CoreError('RENDER_CANCELLED', 'render was cancelled');
        const svgAbsolute = assertInside(root, join(root, artifact.svgPath));
        const sourceAbsolute = assertInside(root, join(root, artifact.sourcePath));
        await assertNoSymlinkEscape(root, svgAbsolute);
        await assertNoSymlinkEscape(root, sourceAbsolute);
        await atomicWrite(svgAbsolute, sanitizeSvg(artifact.svg, this.config.maxSvgBytes));
        if (this.config.sourceStorage === 'sidecar' || this.config.sourceStorage === 'both') await atomicWrite(sourceAbsolute, artifact.source);
      }
      if (transformedContent !== content) {
        if (options.signal?.aborted) throw new CoreError('RENDER_CANCELLED', 'render was cancelled');
        await assertNoSymlinkEscape(root, note.absolute);
        await atomicWrite(note.absolute, transformedContent);
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      errors.push(asStructuredError(error));
      return { operation: 'sync_note', notePath: note.relative, apply, changed: false, conflict: false, blocks: plans, transformedContent: content, errors, warnings };
    }
    return { operation: 'sync_note', notePath: note.relative, apply, changed: transformedContent !== content, conflict: false, blocks: plans, transformedContent, errors, warnings };
  }

  private restoreFence(block: ManagedBlock, source: string, fenceOverride?: ManagedMarker['fence']): string {
    const fence = fenceOverride ?? block.marker.fence ?? { char: '`', length: 3, info: 'mermaid', prefix: block.prefix, containerPrefix: block.prefix, newline: '\n' as const };
    const newline = fence.newline || '\n';
    const prefix = fence.prefix || block.prefix || '';
    const opener = `${prefix}${fence.char.repeat(Math.max(3, fence.length || 3))}${fence.info ? fence.info : 'mermaid'}`;
    const trimmed = normalizeSource(source).replace(/\n+$/gu, '');
    const body = trimmed.split('\n').map((line) => `${prefix}${line}`).join(newline);
    const suffix = fence.trailingNewline === false ? '' : newline;
    return `${opener}${newline}${body}${newline}${prefix}${fence.char.repeat(Math.max(3, fence.length || 3))}${suffix}`;
  }

  async restore(notePath: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    return this.enqueueNote(notePath, () => this.restoreInternal(notePath, options));
  }

  private async restoreInternal(notePath: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    const note = await this.noteAbsolute(notePath);
    const apply = options.apply === true;
    const initial = await this.fingerprint(note.absolute);
    if (options.expectedHash && options.expectedHash !== initial.sha256) return { operation: 'restore_note', notePath: note.relative, apply, changed: false, conflict: true, restored: [], errors: [{ code: 'CONCURRENT_MODIFICATION', message: 'expectedHash does not match current note', path: note.relative }], warnings: [] };
    const content = await readFile(note.absolute, 'utf8');
    const scanned = scanMarkdown(content);
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    const restored: RestoreResult['restored'] = [];
    const errors: StructuredError[] = [];
    for (const block of scanned.managed) {
      if (options.signal?.aborted) throw new CoreError('RENDER_CANCELLED', 'restore was cancelled');
      try {
        const recovered = await this.readManagedSource(block.marker);
        if (!recovered.source) throw new CoreError('SOURCE_NOT_FOUND', 'managed block has no readable sidecar or SVG metadata');
        replacements.push({ start: block.start, end: block.end, value: this.restoreFence(block, recovered.source, recovered.fence) });
        restored.push({ id: block.marker.id, sourceHash: block.marker.hash, sourcePath: recovered.sourcePath, status: 'restored' });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const structured = asStructuredError(error, 'SOURCE_NOT_FOUND');
        structured.blockId = block.marker.id;
        errors.push(structured);
        restored.push({ id: block.marker.id, sourceHash: block.marker.hash, status: 'failed' });
      }
    }
    const transformedContent = replacements.length ? applyReplacements(content, replacements) : content;
    if (!apply) return { operation: 'restore_note', notePath: note.relative, apply, changed: transformedContent !== content, conflict: false, restored, transformedContent, errors, warnings: [] };
    if (options.signal?.aborted) throw new CoreError('RENDER_CANCELLED', 'restore was cancelled');
    const beforeCommit = await this.fingerprint(note.absolute);
    if (beforeCommit.sha256 !== initial.sha256 || beforeCommit.size !== initial.size || beforeCommit.mtimeMs !== initial.mtimeMs) return { operation: 'restore_note', notePath: note.relative, apply, changed: false, conflict: true, restored, transformedContent: content, errors: [...errors, { code: 'CONCURRENT_MODIFICATION', message: 'note changed while restoring', path: note.relative }], warnings: [] };
    if ((errors.length === 0 || replacements.length > 0) && transformedContent !== content) {
      await assertNoSymlinkEscape(this.requireRoot(), note.absolute);
      await atomicWrite(note.absolute, transformedContent);
    }
    return { operation: 'restore_note', notePath: note.relative, apply, changed: transformedContent !== content, conflict: false, restored, transformedContent, errors, warnings: [] };
  }
}
