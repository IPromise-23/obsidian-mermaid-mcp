#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  CoreError, VaultService, asStructuredError, atomicWrite, assertInside, assertNoSymlinkEscape,
  assertRelativeVaultPath,
  injectMetadata, loadConfig, resolveRenderOptions, resolveVaultRoot, sha256, type RenderOptions
} from '@obsidian-mermaid-mcp/core';

const VERSION = '0.1.0';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function response(value: unknown, isError = false): any {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value as Record<string, unknown>, isError };
}

const toolCommon = {
  theme: z.enum(['default', 'dark', 'neutral', 'forest', 'base', 'auto']).optional(),
  themeContext: z.enum(['light', 'dark']).optional(),
  background: z.string().optional(),
  embedWidth: z.number().int().nonnegative().nullable().optional(),
  apply: z.boolean().optional(),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/iu).optional()
};

async function main(): Promise<void> {
  const vaultRoot = argValue('--vault-root') ?? process.env.OBSIDIAN_MERMAID_VAULT_ROOT;
  const config = await loadConfig(argValue('--config') ?? process.env.OBSIDIAN_MERMAID_CONFIG);
  const configuredRoot = vaultRoot ?? config.vaultRoot;
  const resolvedVaultRoot = configuredRoot ? await resolveVaultRoot(configuredRoot) : undefined;
  const service = new VaultService(resolvedVaultRoot, config);
  await service.initialize();
  const server = new McpServer({ name: 'obsidian-mermaid-mcp', version: VERSION });

  server.registerTool('extract_mermaid_source', {
    description: 'Extract Mermaid fences from a vault-relative Markdown note or recover source from a managed SVG.',
    inputSchema: z.object({ notePath: z.string().optional(), svgPath: z.string().optional() })
  }, async (input) => {
    try { return response(await service.extract(input)); }
    catch (error) { return response(asStructuredError(error, 'SOURCE_NOT_FOUND'), true); }
  });

  server.registerTool('render_mermaid', {
    description: 'Render Mermaid source to sanitized SVG. This is preview-only unless apply=true and outputPath is provided.',
    inputSchema: z.object({
      source: z.string().min(1),
      theme: toolCommon.theme,
      themeContext: toolCommon.themeContext,
      background: toolCommon.background,
      apply: z.boolean().optional(),
      outputPath: z.string().min(1).optional(),
      notePath: z.string().optional()
    })
  }, async (input, context) => {
    try {
      const options: Partial<RenderOptions> = {
        theme: input.theme,
        themeContext: input.themeContext,
        background: input.background ?? 'transparent'
      };
      const rendered = await service.render(input.source, options, context.mcpReq.signal);
      let outputPath: string | undefined;
      if (input.apply === true) {
        if (!input.outputPath) throw new CoreError('OUTPUT_PATH_REQUIRED', 'outputPath is required when apply=true');
        const root = resolvedVaultRoot;
        if (!root) throw new CoreError('VAULT_ROOT_REQUIRED', 'vault root is required for output writes');
        outputPath = assertRelativeVaultPath(input.outputPath, 'outputPath');
        const absolute = assertInside(root, join(root, outputPath));
        await assertNoSymlinkEscape(root, absolute);
        const resolved = resolveRenderOptions({
          theme: input.theme ?? config.theme,
          themeContext: input.themeContext,
          background: options.background ?? config.background,
          htmlLabels: config.htmlLabels,
          securityLevel: 'strict'
        });
        const metadata = {
          version: 1 as const,
          id: 'standalone',
          sourceHash: sha256(input.source),
          source: input.source,
          theme: resolved.theme,
          themeContext: resolved.themeContext,
          background: resolved.background,
          renderer: rendered.renderer,
          rendererVersion: rendered.rendererVersion
        };
        await atomicWrite(absolute, injectMetadata(rendered.svg, metadata, config.maxSvgBytes));
      }
      return response({ ...rendered, svgBase64: Buffer.from(rendered.svg, 'utf8').toString('base64'), svg: undefined, outputPath });
    } catch (error) { return response(asStructuredError(error, 'MERMAID_PARSE_ERROR'), true); }
  });

  server.registerTool('sync_note', {
    description: 'Preview or apply Mermaid fence conversion for one vault-relative Markdown note.',
    inputSchema: z.object({
      notePath: z.string().min(1),
      blockIds: z.array(z.string()).optional(),
      ...toolCommon
    })
  }, async (input, context) => {
    try { return response(await service.sync(input.notePath, { ...input, signal: context.mcpReq.signal })); }
    catch (error) { return response(asStructuredError(error, 'SYNC_FAILED'), true); }
  });

  server.registerTool('restore_note', {
    description: 'Preview or apply restoration of managed SVG blocks to their original Mermaid fences.',
    inputSchema: z.object({
      notePath: z.string().min(1),
      apply: z.boolean().optional(),
      expectedHash: toolCommon.expectedHash
    })
  }, async (input, context) => {
    try { return response(await service.restore(input.notePath, { ...input, signal: context.mcpReq.signal })); }
    catch (error) { return response(asStructuredError(error, 'RESTORE_FAILED'), true); }
  });

  const transport = new StdioServerTransport();
  const cleanup = async (): Promise<void> => {
    await service.close();
  };
  process.once('SIGINT', () => { void cleanup().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });
  process.stdin.once('end', () => { void cleanup(); });
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`[obsidian-mermaid-mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
