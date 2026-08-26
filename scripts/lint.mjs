import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.(?:ts|mjs|json|md)$/u.test(entry.name)) result.push(path);
  }
  return result;
}

const root = new URL('..', import.meta.url).pathname;
const violations = [];
for (const path of await files(root)) {
  const text = await readFile(path, 'utf8');
  if (/console\.log\s*\(/u.test(text) && !path.endsWith('scripts/stdio-smoke.mjs')) violations.push(`${path}: console.log would pollute stdio`);
  if (/[ \t]+$/mu.test(text)) violations.push(`${path}: trailing whitespace`);
}
if (violations.length) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('lint: no protocol or whitespace violations\n');
}
