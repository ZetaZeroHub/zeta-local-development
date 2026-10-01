import { constants } from 'node:fs';
import { mkdir, realpath, lstat, readdir, open, rename, link, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { failure } from './api.mjs';
import { hash } from './source-snapshot.mjs';

const blocked = () => failure('目录包含符号链接、路径冲突或不安全文件，请保留文件并检查目录。', 'LOCAL_PATH');
const conflict = () => failure('本地文件有修改，已保留原文件。请先查看 status 并处理差异。', 'LOCAL_CONFLICT');
const missing = error => error.code === 'ENOENT';

export async function withProjectFiles(directory, initialize, action) {
  const requested = path.resolve(directory);
  if (initialize) { try { await mkdir(requested, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const rootStat = await lstat(requested);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw blocked();
  const root = await realpath(requested);
  async function checked(relative, parents = false) {
    if (typeof relative !== 'string' || !relative.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..') || relative.startsWith('/')) throw blocked();
    const currentRoot = await lstat(root);
    if (currentRoot.ino !== rootStat.ino || currentRoot.dev !== rootStat.dev || currentRoot.isSymbolicLink()) throw blocked();
    const parts = relative.split('/'); let current = root;
    for (let i = 0; i < parts.length; i++) {
      const names = await readdir(current);
      if (names.some(name => name.toLowerCase() === parts[i].toLowerCase() && name !== parts[i])) throw blocked();
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await lstat(current); } catch (error) {
        if (!missing(error)) throw error;
        if (i === parts.length - 1) return current;
        if (!parents) return null;
        await mkdir(current, { mode: 0o700 }); stat = await lstat(current);
      }
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1))) throw blocked();
    }
    return current;
  }
  async function read(relative, limit = 32 * 1024 * 1024) {
    const target = await checked(relative);
    if (!target) return null;
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw blocked();
      const content = await handle.readFile();
      if (content.length > limit) throw blocked();
      return content;
    } catch (error) { if (missing(error)) return null; throw error; }
    finally { await handle?.close(); }
  }
  async function atomic(relative, bytes, expectedHash) {
    const target = await checked(relative, true);
    const temporary = path.join(path.dirname(target), '.zeta-tmp-' + randomUUID());
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      const current = await read(relative, 100 * 1024 * 1024);
      if (expectedHash !== undefined && (current === null ? null : hash(current)) !== expectedHash) throw conflict();
      await checked(relative); await rename(temporary, target);
    } finally { await handle?.close(); await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }
  const names = await readdir(root);
  if (!names.includes('.zeta')) {
    if (!initialize || names.length) throw failure('init 只能使用空目录；已有工程请使用其原目录。', 'NOT_EMPTY');
    await mkdir(path.join(root, '.zeta'), { mode: 0o700 });
  }
  const metadata = await lstat(path.join(root, '.zeta'));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw blocked();
  const owner = Buffer.from(JSON.stringify({ pid: process.pid, host: hostname(), nonce: randomUUID() }));
  const preparation = '.zeta/lock-' + randomUUID();
  await atomic(preparation, owner, null);
  const lock = path.join(root, '.zeta/lock');
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await link(path.join(root, preparation), lock); acquired = true; break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await lstat(lock);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 2 || stat.size > 1024) throw blocked();
        const h = await open(lock, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        let previous; try { previous = await h.readFile(); } finally { await h.close(); }
        let value; try { value = JSON.parse(previous); } catch { throw blocked(); }
        let alive = true;
        if (value.host === hostname() && Number.isSafeInteger(value.pid) && value.pid > 0) {
          try { process.kill(value.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        }
        if (alive) throw failure('另一个本地开发命令正在使用此目录，请等待完成。', 'LOCAL_BUSY');
        throw failure('上次命令异常结束且进程已退出。请确认没有其他命令使用此目录，再移除 .zeta/lock 后重试；恢复记录会保留。', 'STALE_LOCK');
      }
    }
    if (!acquired) throw failure('无法取得目录锁，请重试。', 'LOCAL_BUSY');
    await unlink(path.join(root, preparation));
    const json = async relative => { const raw = await read(relative, 100 * 1024 * 1024); if (raw === null) return null; try { return JSON.parse(raw); } catch { throw failure('本地恢复记录损坏，请保留目录以便恢复。', 'LOCAL_STATE'); } };
    const writeJSON = (relative, value) => atomic(relative, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
    return await action({ root, read, json, writeJSON, atomic, async assertFresh() {
      if ((await readdir(root)).some(name => name !== '.zeta') || (await readdir(path.join(root, '.zeta'))).some(name => !['lock', '.gitignore'].includes(name))) throw failure('init 只能使用空目录，当前目录未创建远端项目。', 'NOT_EMPTY');
    }, async remove(relative, expectedHash) {
      const current = await read(relative); if (current === null) return;
      if (hash(current) !== expectedHash) throw conflict();
      await unlink(await checked(relative));
    } });
  } finally {
    if (acquired) await unlink(lock);
    await unlink(path.join(root, preparation)).catch(error => { if (!missing(error)) throw error; });
  }
}
