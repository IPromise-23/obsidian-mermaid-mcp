import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const fixture = await mkdtemp(join(tmpdir(), 'obsidian-mermaid-mcp-'));
await mkdir(join(fixture, 'assets'), { recursive: true });
await writeFile(join(fixture, 'note.md'), '# Smoke\n\n```mermaid\nflowchart LR\n A-->B\n```\n');
const child = spawn(process.execPath, ['packages/mcp-server/dist/index.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, OBSIDIAN_MERMAID_VAULT_ROOT: fixture },
  stdio: ['pipe', 'pipe', 'pipe']
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
const waitForId = (id, timeoutMs = 12000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + timeoutMs;
  const tick = () => {
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id === id) return resolve(parsed);
      } catch {
        return reject(new Error(`non-JSON stdout: ${line}`));
      }
    }
    if (Date.now() > deadline) return reject(new Error(`timeout waiting for id ${id}; stderr=${stderr}`));
    setTimeout(tick, 30);
  };
  tick();
});
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0.1.0' } } });
  await waitForId(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await waitForId(2);
  const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
  const expected = ['extract_mermaid_source', 'render_mermaid', 'restore_note', 'sync_note'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`unexpected tools: ${names.join(',')}`);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'extract_mermaid_source', arguments: { notePath: 'note.md' } } });
  await waitForId(3);
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'render_mermaid', arguments: { source: 'flowchart LR\n A-->B' } } });
  await waitForId(4, 30000);
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'sync_note', arguments: { notePath: 'note.md', apply: false } } });
  await waitForId(5, 30000);
  const note = await readFile(join(fixture, 'note.md'), 'utf8');
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'restore_note', arguments: { notePath: 'note.md', apply: false } } });
  await waitForId(6, 30000);
  const protocolLines = stdout.split('\n').filter((line) => line.trim());
  for (const line of protocolLines) {
    let message;
    try { message = JSON.parse(line); } catch { throw new Error(`non-JSON stdout: ${line}`); }
    if (message.jsonrpc !== '2.0') throw new Error(`stdout line is not JSON-RPC 2.0: ${line}`);
  }
  process.stdout.write(`stdio smoke: tools/list=${names.join(',')} stdout-json-lines=${protocolLines.length}\n`);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(fixture, { recursive: true, force: true });
}
