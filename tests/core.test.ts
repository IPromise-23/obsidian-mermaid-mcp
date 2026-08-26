import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DeterministicRenderer, VaultService, scanMarkdown, sanitizeSvg, readMetadata, injectMetadata,
  assertRelativeVaultPath, CoreError, resolveRenderOptions, sha256, expandTemplate, safeNoteName
} from '@obsidian-mermaid-mcp/core';

describe('fence scanner', () => {
  it('finds Mermaid, tilde, callout, and CRLF fences without matching ordinary code', () => {
    const content = [
      '---', 'title: demo', '---', '',
      '> [!NOTE]', '> ```mermaid', '> flowchart LR', '> A-->B', '> ```', '',
      '````text', '```mermaid', 'not a block', '```', '````', '',
      '~~~mermaid', 'sequenceDiagram', 'A->>B: hi', '~~~', ''
    ].join('\r\n');
    const result = scanMarkdown(content);
    expect(result.fences).toHaveLength(2);
    expect(result.fences[0]?.source).toContain('flowchart LR');
    expect(result.fences[0]?.containerPrefix).toBe('> ');
    expect(result.fences[1]?.fenceChar).toBe('~');
    expect(result.fences[1]?.newline).toBe('\r\n');
  });
});

describe('SVG safety and metadata', () => {
  it('removes scripts/events/external URLs and round-trips metadata', () => {
    const unsafe = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><a onclick="x" href="https://bad.example"><text>ok</text></a></svg>';
    const clean = sanitizeSvg(unsafe);
    expect(clean).not.toMatch(/script|onclick|https:\/\/bad/iu);
    const withMetadata = injectMetadata(clean, {
      version: 1, id: 'mm-test', sourceHash: sha256('flowchart LR\n A-->B'), source: 'flowchart LR\n A-->B',
      theme: 'default', background: 'transparent', renderer: 'test', rendererVersion: '1'
    });
    expect(readMetadata(withMetadata)?.source).toBe('flowchart LR\n A-->B');
    expect(() => sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://bad.example/x.css)</style></svg>')).toThrow(CoreError);
    expect(() => sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>.x{background:url(remote.png)}</style></svg>')).toThrow(CoreError);
    expect(() => sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(remote.png)"/></svg>')).toThrow(CoreError);
    expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><image src="https://bad.example/x.png"/></svg>')).not.toMatch(/bad\.example/iu);
    expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect style="fill:url(#g)"/></svg>')).toContain('url(#g)');
    expect(() => resolveRenderOptions({ theme: 'default', background: 'url(https://bad.example)' })).toThrow(CoreError);
  });
});

describe('vault sync and restore', () => {
  it('previews, applies, stays idempotent, and restores from sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omm-test-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    const notePath = join(root, '测试笔记.md');
    const original = '# Demo\n\n```mermaid\nflowchart LR\n A-->B\n```\n';
    await writeFile(notePath, original);
    const service = new VaultService(root, {}, new DeterministicRenderer());
    await service.initialize();
    const preview = await service.sync('测试笔记.md');
    expect(preview.apply).toBe(false);
    expect(preview.changed).toBe(true);
    expect(await readFile(notePath, 'utf8')).toBe(original);
    const applied = await service.sync('测试笔记.md', { apply: true });
    expect(applied.changed).toBe(true);
    const converted = await readFile(notePath, 'utf8');
    expect(converted).not.toContain('<!-- obsidian-mermaid-mcp:v1');
    expect(converted).toContain('![[assets/测试笔记/mermaid-001-');
    expect(converted).toContain('|600]]');
    const second = await service.sync('测试笔记.md', { apply: true });
    expect(second.blocks.every((block) => block.status === 'cached' || block.status === 'unchanged')).toBe(true);
    const restored = await service.restore('测试笔记.md');
    expect(restored.transformedContent).toContain('```mermaid');
    const restoredApplied = await service.restore('测试笔记.md', { apply: true });
    expect(restoredApplied.changed).toBe(true);
    expect(await readFile(notePath, 'utf8')).toBe(original);
    await service.close();
  });

  it('preserves a note that has no final newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omm-no-final-newline-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    const notePath = join(root, 'note.md');
    const original = '```mermaid\nflowchart LR\n A-->B\n```';
    await writeFile(notePath, original);
    const service = new VaultService(root, {}, new DeterministicRenderer());
    await service.sync('note.md', { apply: true });
    await service.restore('note.md', { apply: true });
    expect(await readFile(notePath, 'utf8')).toBe(original);
  });

  it('round-trips a Mermaid fence with plain indentation without comments in markdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omm-indented-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    const notePath = join(root, 'note.md');
    const original = '  ```mermaid\n  flowchart LR\n  A-->B\n  ```\n';
    await writeFile(notePath, original);
    const service = new VaultService(root, {}, new DeterministicRenderer());
    await service.sync('note.md', { apply: true });
    const converted = await readFile(notePath, 'utf8');
    expect(converted).not.toContain('<!--');
    expect(converted.split('\n')[0]).toMatch(/^  !\[\[/u);
    await service.restore('note.md', { apply: true });
    expect(await readFile(notePath, 'utf8')).toBe(original);
  });

  it('round-trips nested callout indentation and does not rewrite an unchanged note', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omm-nested-callout-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    const notePath = join(root, 'nested.md');
    const original = '>   ```mermaid\n>   flowchart LR\n>    A-->B\n>   ```\n';
    await writeFile(notePath, original);
    const service = new VaultService(root, {}, new DeterministicRenderer());
    await service.sync('nested.md', { apply: true });
    const firstStat = await stat(notePath);
    const second = await service.sync('nested.md', { apply: true });
    const secondStat = await stat(notePath);
    expect(second.errors).toHaveLength(0);
    expect(second.changed).toBe(false);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    await service.restore('nested.md', { apply: true });
    expect(await readFile(notePath, 'utf8')).toBe(original);
    await service.close();
  });

  it('uses SVG metadata when sidecar storage is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omm-metadata-only-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'note.md'), '```mermaid\nflowchart LR\n A-->B\n```\n');
    const service = new VaultService(root, { sourceStorage: 'metadata' }, new DeterministicRenderer());
    await service.sync('note.md', { apply: true });
    const result = await service.sync('note.md', { apply: true });
    expect(result.errors).toHaveLength(0);
    expect(result.changed).toBe(false);
    await service.close();
  });

  it('rejects traversal and detects concurrent changes before commit', async () => {
    expect(() => assertRelativeVaultPath('../escape.md')).toThrow(CoreError);
    const root = await mkdtemp(join(tmpdir(), 'omm-conflict-'));
    const notePath = join(root, 'note.md');
    await writeFile(notePath, '```mermaid\nflowchart LR\n A-->B\n```\n');
    const slowRenderer = {
      async render(source: string, options: any) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new DeterministicRenderer().render(source, options);
      }
    };
    const service = new VaultService(root, {}, slowRenderer);
    const pending = service.sync('note.md', { apply: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(notePath, 'changed by user\n');
    const result = await pending;
    expect(result.conflict).toBe(true);
    expect(await readFile(notePath, 'utf8')).toBe('changed by user\n');
  });

  it('supports note-relative assets template with empty and non-empty note_dir, including Chinese paths', async () => {
    const pattern = '{note_dir}/assets/{note_name}/mermaid-{index}-{hash}.svg';
    const rootValues = {
      asset_root: 'assets',
      note_name: safeNoteName('root-note.md'),
      note_path: 'root-note.md',
      note_dir: '',
      index: '001',
      block_id: 'mm-test',
      hash: 'abcdef0123456789',
      ext: 'svg'
    };
    expect(expandTemplate(pattern, rootValues)).toBe('assets/root-note/mermaid-001-abcdef0123456789.svg');

    const nestedValues = {
      asset_root: 'assets',
      note_name: safeNoteName('Agent学习笔记/测试笔记.md'),
      note_path: 'Agent学习笔记/测试笔记.md',
      note_dir: 'Agent学习笔记',
      index: '001',
      block_id: 'mm-test',
      hash: 'abcdef0123456789',
      ext: 'svg'
    };
    expect(expandTemplate(pattern, nestedValues)).toBe('Agent学习笔记/assets/测试笔记/mermaid-001-abcdef0123456789.svg');

    const root = await mkdtemp(join(tmpdir(), 'omm-nested-test-'));
    const nestedDir = join(root, 'Agent学习笔记');
    await mkdir(nestedDir, { recursive: true });
    const notePath = join(nestedDir, '测试笔记.md');
    const original = '# 测试\n\n```mermaid\nflowchart TD\n Start --> End\n```\n';
    await writeFile(notePath, original);

    const service = new VaultService(root, {
      attachmentPattern: '{note_dir}/assets/{note_name}/mermaid-{index}-{hash}.svg',
      sourcePattern: '{note_dir}/assets/{note_name}/mermaid-{index}-{hash}.mmd'
    }, new DeterministicRenderer());
    await service.initialize();

    const applied = await service.sync('Agent学习笔记/测试笔记.md', { apply: true });
    expect(applied.changed).toBe(true);
    expect(applied.blocks).toHaveLength(1);
    expect(applied.blocks[0]?.svgPath).toMatch(/^Agent学习笔记\/assets\/测试笔记\/mermaid-001-[a-f0-9]{16}\.svg$/);
    expect(applied.blocks[0]?.sourcePath).toMatch(/^Agent学习笔记\/assets\/测试笔记\/mermaid-001-[a-f0-9]{16}\.mmd$/);

    const svgExists = await stat(join(root, applied.blocks[0]!.svgPath));
    const mmdExists = await stat(join(root, applied.blocks[0]!.sourcePath));
    expect(svgExists.isFile()).toBe(true);
    expect(mmdExists.isFile()).toBe(true);

    const restored = await service.restore('Agent学习笔记/测试笔记.md', { apply: true });
    expect(restored.changed).toBe(true);
    expect(await readFile(notePath, 'utf8')).toBe(original);
    await service.close();
  });

  it('updates SVG when .mmd sidecar is modified under clean embed mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omm-sidecar-clean-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    const notePath = join(root, 'doc.md');
    const original = '# Title\n\n```mermaid\nflowchart LR\n A-->B\n```\n';
    await writeFile(notePath, original);

    const service = new VaultService(root, {}, new DeterministicRenderer());
    await service.initialize();

    const firstSync = await service.sync('doc.md', { apply: true });
    expect(firstSync.changed).toBe(true);
    const sidecarPath = firstSync.blocks[0]!.sourcePath;

    // Modify the .mmd sidecar directly (e.g. from mobile or another editor)
    const newMermaid = 'flowchart LR\n A-->B\n B-->C\n';
    await writeFile(join(root, sidecarPath), newMermaid);

    // Sync note again
    const secondSync = await service.sync('doc.md', { apply: true });
    expect(secondSync.changed).toBe(true);
    expect(secondSync.blocks[0]!.status).toBe('new');

    const updatedNoteContent = await readFile(notePath, 'utf8');
    expect(updatedNoteContent).not.toContain('<!--');
    expect(updatedNoteContent).toContain('![[');

    // Restore should recover the updated diagram
    const restored = await service.restore('doc.md', { apply: true });
    expect(restored.changed).toBe(true);
    expect(await readFile(notePath, 'utf8')).toBe('# Title\n\n```mermaid\nflowchart LR\n A-->B\n B-->C\n```\n');
    await service.close();
  });

  it('restores legacy notes that contain HTML comments back to clean fences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omm-legacy-compat-'));
    await mkdir(join(root, 'assets', 'legacy'), { recursive: true });
    const notePath = join(root, 'legacy.md');

    // Create a note with legacy HTML comment
    const svgPath = 'assets/legacy/mermaid-001-f97437d9e714d8ee.svg';
    const mmdPath = 'assets/legacy/mermaid-001-f97437d9e714d8ee.mmd';
    const legacyComment = '<!-- obsidian-mermaid-mcp:v1 {"version":1,"id":"mm-f97437d9e714","svg":"' + svgPath + '","source":"' + mmdPath + '","hash":"f97437d9e714d8ee","note":"legacy.md","fence":{"char":"`","length":3,"info":"mermaid","prefix":"","containerPrefix":"","newline":"\\n","trailingNewline":true}} -->';
    const legacyContent = `# Legacy\n\n${legacyComment}\n![[${svgPath}|600]]\n`;
    await writeFile(notePath, legacyContent);
    await writeFile(join(root, mmdPath), 'flowchart TD\n X-->Y\n');

    const service = new VaultService(root, {}, new DeterministicRenderer());
    await service.initialize();

    const restored = await service.restore('legacy.md', { apply: true });
    expect(restored.changed).toBe(true);
    const restoredContent = await readFile(notePath, 'utf8');
    expect(restoredContent).not.toContain('<!--');
    expect(restoredContent).toBe('# Legacy\n\n```mermaid\nflowchart TD\n X-->Y\n```\n');
    await service.close();
  });
});

