import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, detectObsidianVaultConfig, detectBrowserCandidates } from '@obsidian-mermaid-mcp/core';

describe('configuration loading', () => {
  it('maps the documented nested renderer settings without leaking the wrapper object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omm-config-'));
    const path = join(root, 'config.json');
    try {
      await writeFile(path, JSON.stringify({
        configVersion: 1,
        assetRoot: 'attachments',
        embedWidth: 720,
        renderer: {
          timeoutMs: 12_000,
          browserIdleTimeoutMs: 42_000,
          maxSourceBytes: 1234,
          maxOutputBytes: 5678,
          htmlLabels: true,
          executablePath: '/custom/chrome'
        }
      }));
      const config = await loadConfig(path);
      expect(config.assetRoot).toBe('attachments');
      expect(config.embedWidth).toBe(720);
      expect(config.renderTimeoutMs).toBe(12_000);
      expect(config.browserIdleTimeoutMs).toBe(42_000);
      expect(config.maxSourceBytes).toBe(1234);
      expect(config.maxSvgBytes).toBe(5678);
      expect(config.htmlLabels).toBe(true);
      expect(config.browserExecutablePath).toBe('/custom/chrome');
      expect('renderer' in config).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('automatically detects Obsidian attachment settings from .obsidian/app.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omm-obsidian-detect-'));
    try {
      const dotObsidian = join(root, '.obsidian');
      await mkdir(dotObsidian, { recursive: true });

      // Case 1: "assets/${filename}" subfolder pattern
      await writeFile(join(dotObsidian, 'app.json'), JSON.stringify({
        attachmentFolderPath: 'assets/${filename}'
      }));
      const detected1 = await detectObsidianVaultConfig(root);
      expect(detected1.attachmentPattern).toBe('{note_dir}/assets/{note_name}/mermaid-{index}-{hash}.svg');
      expect(detected1.sourcePattern).toBe('{note_dir}/assets/{note_name}/mermaid-{index}-{hash}.mmd');

      // Case 2: "./" same folder pattern
      await writeFile(join(dotObsidian, 'app.json'), JSON.stringify({
        attachmentFolderPath: './'
      }));
      const detected2 = await detectObsidianVaultConfig(root);
      expect(detected2.attachmentPattern).toBe('{note_dir}/mermaid-{index}-{hash}.svg');

      // Case 3: Fixed folder name e.g. "attachments"
      await writeFile(join(dotObsidian, 'app.json'), JSON.stringify({
        attachmentFolderPath: 'attachments'
      }));
      const detected3 = await detectObsidianVaultConfig(root);
      expect(detected3.assetRoot).toBe('attachments');
      expect(detected3.attachmentPattern).toBe('{asset_root}/{note_name}/mermaid-{index}-{hash}.svg');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects browser candidates across OS platforms or falls back to configured path', () => {
    const custom = detectBrowserCandidates('/my/custom/chrome');
    expect(custom).toEqual(['/my/custom/chrome']);

    const detected = detectBrowserCandidates();
    expect(detected.length).toBeGreaterThan(0);
  });
});
