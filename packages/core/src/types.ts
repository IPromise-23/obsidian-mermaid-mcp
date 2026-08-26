export type MermaidTheme = 'default' | 'dark' | 'neutral' | 'forest' | 'base' | 'auto';
export type ThemeContext = 'light' | 'dark';
export type Background = 'transparent' | string;
export type SourceStorage = 'metadata' | 'sidecar' | 'both';
export type FailurePolicy = 'partial' | 'all_or_nothing';

export interface RenderOptions {
  theme: MermaidTheme;
  themeContext?: ThemeContext;
  background: Background;
  htmlLabels?: boolean;
  securityLevel?: 'strict';
  timeoutMs?: number;
}

export interface ResolvedRenderOptions extends Omit<RenderOptions, 'theme'> {
  theme: Exclude<MermaidTheme, 'auto'>;
  warnings: string[];
}

export interface RenderedSvg {
  svg: string;
  renderer: string;
  rendererVersion: string;
  sourceHash: string;
  renderHash: string;
  warnings: string[];
}

export interface FenceBlock {
  kind: 'fence';
  index: number;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  fenceChar: '`' | '~';
  fenceLength: number;
  info: string;
  source: string;
  prefix: string;
  containerPrefix: string;
  newline: '\n' | '\r\n';
  raw: string;
}

export interface ManagedBlock {
  kind: 'managed';
  index: number;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  marker: ManagedMarker;
  embed: string;
  prefix: string;
  raw: string;
}

export interface ManagedMarker {
  version: 1;
  id: string;
  svg: string;
  source?: string;
  hash: string;
  note?: string;
  fence?: {
    char: '`' | '~';
    length: number;
    info: string;
    prefix: string;
    containerPrefix: string;
    newline: '\n' | '\r\n';
    trailingNewline?: boolean;
  };
}

export interface NoteFingerprint {
  sha256: string;
  size: number;
  mtimeMs: number;
}

export interface AssetPlan {
  id: string;
  index: number;
  svgPath: string;
  sourcePath: string;
  sourceHash: string;
  renderHash: string;
  embed: string;
  status: 'new' | 'cached' | 'failed' | 'unchanged';
  error?: StructuredError;
  warnings: string[];
}

export interface SyncResult {
  operation: 'sync_note';
  notePath: string;
  apply: boolean;
  changed: boolean;
  conflict: boolean;
  blocks: AssetPlan[];
  transformedContent?: string;
  errors: StructuredError[];
  warnings: string[];
}

export interface RestoreResult {
  operation: 'restore_note';
  notePath: string;
  apply: boolean;
  changed: boolean;
  conflict: boolean;
  restored: Array<{ id: string; sourceHash: string; sourcePath?: string; status: 'restored' | 'failed' }>;
  transformedContent?: string;
  errors: StructuredError[];
  warnings: string[];
}

export interface StructuredError {
  code: string;
  message: string;
  path?: string;
  blockId?: string;
  details?: Record<string, unknown>;
}

export interface MermaidRenderer {
  render(source: string, options: RenderOptions, signal?: AbortSignal): Promise<RenderedSvg>;
}

export interface CoreConfig {
  vaultRoot?: string;
  browserExecutablePath?: string;
  assetRoot: string;
  attachmentPattern: string;
  sourcePattern: string;
  embedWidth: number | null;
  theme: MermaidTheme;
  background: Background;
  sourceStorage: SourceStorage;
  failurePolicy: FailurePolicy;
  maxSourceBytes: number;
  maxSvgBytes: number;
  renderTimeoutMs: number;
  browserIdleTimeoutMs: number;
  maxConcurrentRenders: number;
  htmlLabels: boolean;
  watcherDebounceMs: number;
}

export const DEFAULT_CONFIG: CoreConfig = {
  assetRoot: 'assets',
  attachmentPattern: '{asset_root}/{note_name}/mermaid-{index}-{hash}.svg',
  sourcePattern: '{asset_root}/{note_name}/mermaid-{index}-{hash}.mmd',
  embedWidth: 600,
  theme: 'default',
  background: 'transparent',
  sourceStorage: 'both',
  failurePolicy: 'partial',
  maxSourceBytes: 524_288,
  maxSvgBytes: 8_388_608,
  renderTimeoutMs: 30_000,
  browserIdleTimeoutMs: 300_000,
  maxConcurrentRenders: 1,
  htmlLabels: false,
  watcherDebounceMs: 3000
};
