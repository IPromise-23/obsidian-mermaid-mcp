import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { CoreError } from './errors.js';

function containsTraversal(value: string): boolean {
  return value.split(/[\\/]+/u).some((part) => part === '..');
}

export function assertRelativeVaultPath(value: string, label = 'path'): string {
  if (!value || value.includes('\0') || isAbsolute(value) || containsTraversal(value)) {
    throw new CoreError('PATH_ESCAPE', `${label} must be a non-empty vault-relative path without traversal`);
  }
  const normal = normalize(value).replaceAll('\\', '/');
  if (normal === '.' || normal.startsWith('../') || normal.includes('/../') || normal.endsWith('/..')) {
    throw new CoreError('PATH_ESCAPE', `${label} escapes the vault root`);
  }
  return normal;
}

export function assertInside(root: string, candidate: string): string {
  const rootNormal = normalize(root);
  const candidateNormal = normalize(candidate);
  const rel = relative(rootNormal, candidateNormal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CoreError('PATH_ESCAPE', 'resolved path escapes the configured vault root', { root, candidate });
  }
  return candidateNormal;
}

export async function resolveVaultRoot(root: string): Promise<string> {
  const resolved = await realpath(root);
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) throw new CoreError('INVALID_VAULT_ROOT', 'vault root is not a directory');
  return resolved;
}

export async function assertNoSymlinkEscape(root: string, candidate: string, allowMissing = true): Promise<void> {
  const resolvedRoot = await realpath(root);
  assertInside(resolvedRoot, normalize(candidate));
  let current = normalize(candidate);
  const pending: string[] = [];
  while (true) {
    const parent = dirname(current);
    if (parent === current) break;
    pending.unshift(current.slice(parent.length + 1));
    current = parent;
    if (current === resolvedRoot) break;
  }
  let cursor = resolvedRoot;
  for (const part of pending) {
    cursor = join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new CoreError('SYMLINK_ESCAPE', 'symbolic links are not allowed in write paths', { path: cursor });
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  try {
    await access(candidate, constants.F_OK);
    const actual = await realpath(candidate);
    assertInside(resolvedRoot, actual);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function expandTemplate(pattern: string, values: Record<string, string | number>): string {
  const expanded = pattern.replace(/\{([a-z_]+)\}/gu, (full, key: string) => {
    const value = values[key];
    if (value === undefined) throw new CoreError('INVALID_TEMPLATE', `unknown template placeholder: ${key}`);
    return String(value);
  });
  if (expanded.includes('\0') || containsTraversal(expanded)) {
    throw new CoreError('PATH_ESCAPE', 'expanded attachment template is unsafe');
  }
  const normalized = normalize(expanded).replaceAll('\\', '/').replace(/^\/+/u, '');
  if (!normalized || isAbsolute(normalized) || containsTraversal(normalized) || normalized.startsWith('../')) {
    throw new CoreError('PATH_ESCAPE', 'expanded attachment template is unsafe');
  }
  return normalized;
}

export function safeNoteName(notePath: string): string {
  const base = notePath.split('/').pop()?.replace(/\.md$/iu, '') ?? 'note';
  return base.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120) || 'note';
}
