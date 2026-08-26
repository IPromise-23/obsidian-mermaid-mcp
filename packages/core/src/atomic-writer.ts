import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function atomicWrite(path: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temp, mode);
    await rename(temp, path);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
  }
}
