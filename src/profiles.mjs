import { mkdir, lstat, readFile, writeFile, link, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { endpoint, failure } from './api.mjs';
export function profileDirectory() { return path.join(homedir(), '.config', 'zeta-dev'); }
function filename(name, directory) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw failure('连接名称只能包含小写字母、数字、下划线和连字符。', 'PROFILE');
  return path.join(directory, name + '.json');
}
export function account(profile) { return 'connection:' + createHash('sha256').update(profile.server).digest('hex') + ':' + profile.connectionId; }
function validate(profile) {
  endpoint(profile.server, { originOnly: true }); endpoint(profile.mcpUrl);
  if (new URL(profile.server).origin !== new URL(profile.mcpUrl).origin || !/^[0-9a-f-]{36}$/.test(profile.connectionId || '') || !Number.isFinite(Date.parse(profile.expiresAt))) throw failure('连接信息无效，请重新配对。', 'PROFILE');
  return { server: profile.server, mcpUrl: profile.mcpUrl, connectionId: profile.connectionId, expiresAt: profile.expiresAt };
}
export async function readProfile(name, directory = profileDirectory()) {
  const file = filename(name, directory);
  try {
    if ((await lstat(directory)).isSymbolicLink() || (await lstat(file)).isSymbolicLink()) throw failure('连接文件不能是符号链接。', 'PROFILE');
    return validate(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) { if (error.code === 'ENOENT') return null; if (error.safeMessage) throw error; throw failure('无法读取连接信息。', 'PROFILE'); }
}
export async function saveProfile(name, profile, directory = profileDirectory()) {
  const value = validate(profile); const file = filename(name, directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw failure('连接目录不能是符号链接。', 'PROFILE');
  const temporary = path.join(directory, '.' + randomUUID());
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await link(temporary, file); }
  catch { throw failure('连接文件已存在或无法保存。请在平台撤销本次新连接后重试。', 'PROFILE'); }
  finally { await rm(temporary, { force: true }); }
}
export async function forgetProfile(name, expected, directory = profileDirectory()) {
  const current = await readProfile(name, directory);
  if (!current || current.connectionId !== expected.connectionId || current.server !== expected.server) throw failure('连接信息已变化，请重试。', 'PROFILE');
  await rm(filename(name, directory));
}
