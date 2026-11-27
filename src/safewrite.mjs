// @ts-check
// Write a file without following a symlink planted at the target (e.g. a tracked .api-dead-ends/x/report.json
// pointing to ~/.bashrc): refuse anything that is not a regular file, write to a temp file and rename over it.

import { lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/** @param {string} file @param {string} data */
export async function writeSafe(file, data) {
  try {
    const st = await lstat(file);
    if (!st.isFile()) {
      const what = st.isDirectory() ? 'is a directory' : st.isSymbolicLink() ? 'is a symlink' : 'exists and is not a regular file';
      throw new Error(`${resolve(file)} ${what} — refusing to write`);
    }
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') throw e;
  }
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, data, { flag: 'wx' });
  try { await rename(tmp, file); } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}
