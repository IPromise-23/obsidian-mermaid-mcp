#!/usr/bin/env node
import { watch } from 'chokidar';
import { join, relative } from 'node:path';
import { VaultService, asStructuredError, loadConfig, resolveVaultRoot } from '@obsidian-mermaid-mcp/core';

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  if (process.argv[2] !== 'watch') {
    process.stderr.write('Usage: obsidian-mermaid-watch watch --vault-root <path> [--apply]\n');
    process.exitCode = 2;
    return;
  }
  const config = await loadConfig(value('--config') ?? process.env.OBSIDIAN_MERMAID_CONFIG);
  const root = value('--vault-root') ?? process.env.OBSIDIAN_MERMAID_VAULT_ROOT ?? config.vaultRoot;
  if (!root) throw new Error('--vault-root, OBSIDIAN_MERMAID_VAULT_ROOT, or config.vaultRoot is required');
  const resolvedRoot = await resolveVaultRoot(root);
  const apply = has('--apply');
  const debounceMs = Number(value('--debounce-ms') ?? 2000);
  const service = new VaultService(resolvedRoot, config);
  await service.initialize();
  const pending = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<string>();
  const rerun = new Set<string>();
  const failed = new Map<string, string>();
  const assetRootName = service.config.assetRoot || 'assets';
  const customAssetRegex = new RegExp(`[\\\\/](${assetRootName}|assets|attachments)[\\\\/]`, 'u');
  // Chokidar v4 does not reliably emit changes for a top-level file when the
  // watched path is an absolute `**/*.md` glob. Watch the root directory and
  // filter files explicitly instead.
  const watcher = watch(resolvedRoot, {
    ignoreInitial: true,
    ignored: [/(^|[\\/])\./u, customAssetRegex, /[\\/]node_modules[\\/]/u]
  });
  const processNote = (absolutePath: string): void => {
    if (!absolutePath.toLowerCase().endsWith('.md')) return;
    const notePath = relative(resolvedRoot, absolutePath).replaceAll('\\', '/');
    const old = pending.get(notePath);
    if (old) clearTimeout(old);
    pending.set(notePath, setTimeout(() => {
      pending.delete(notePath);
      if (inFlight.has(notePath)) {
        rerun.add(notePath);
        return;
      }
      inFlight.add(notePath);
      void service.sync(notePath, { apply }).then((result) => {
        const hash = result.blocks.map((block) => block.sourceHash).join(',');
        if (result.errors.length > 0 && failed.get(notePath) === hash) return;
        if (result.errors.length > 0) failed.set(notePath, hash);
        else failed.delete(notePath);
        process.stderr.write(`[watch] ${notePath}: ${result.apply ? 'applied' : 'preview'} ${result.blocks.length} block(s)\n`);
      }).catch((error) => process.stderr.write(`[watch] ${notePath}: ${asStructuredError(error).message}\n`)).finally(() => {
        inFlight.delete(notePath);
        if (rerun.delete(notePath)) processNote(join(resolvedRoot, notePath));
      });
    }, Number.isFinite(debounceMs) ? Math.max(100, debounceMs) : 2000));
  };
  watcher.on('add', processNote).on('change', processNote);
  const close = async (): Promise<void> => {
    await watcher.close();
    for (const timeout of pending.values()) clearTimeout(timeout);
    await service.close();
  };
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGBREAK', () => { void close().finally(() => process.exit(0)); });
  await new Promise<void>(() => undefined);
}

main().catch((error) => {
  process.stderr.write(`[watch] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
