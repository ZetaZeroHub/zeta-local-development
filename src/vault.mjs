import { spawn } from 'node:child_process';
import { access, chmod, mkdir, lstat, rename, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { failure } from './api.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', data => { output += data; if (output.length > 8192) child.kill(); });
    child.stderr.resume(); // Never include a credential provider's output in diagnostics.
    child.once('error', () => { clearTimeout(timer); reject(failure('系统凭证库不可用，请检查平台依赖。', 'VAULT')); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(failure('无法访问系统凭证库。', 'VAULT')); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function macHelper() {
  const directory = path.join(root, '.native');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw failure('凭证辅助目录不能是符号链接。', 'VAULT');
  const source = path.join(root, 'native/keychain.swift');
  const hash = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 16);
  const executable = path.join(directory, 'keychain-' + hash);
  try { await access(executable); if ((await lstat(executable)).isSymbolicLink()) throw failure('凭证程序不能是符号链接。', 'VAULT'); return executable; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = executable + '-' + randomUUID();
  try { await run('/usr/bin/swiftc', ['-O', source, '-o', temporary]); await chmod(temporary, 0o700); await rename(temporary, executable); }
  finally { await rm(temporary, { force: true }); }
  return executable;
}
export async function vault(operation, account, token = '') {
  if (!['set', 'get', 'delete'].includes(operation) || !/^[A-Za-z0-9:_-]{1,180}$/.test(account)) throw failure('凭证索引无效。', 'VAULT');
  if (process.platform === 'darwin') return run(await macHelper(), [], JSON.stringify({ operation, account, token }));
  if (process.platform === 'win32') return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'native/credential.ps1')], JSON.stringify({ operation, account, token }));
  if (process.platform === 'linux') {
    if (operation === 'set') return run('secret-tool', ['store', '--label=Zeta Studio local development', 'service', 'zeta-dev', 'account', account], token);
    return run('secret-tool', [operation === 'get' ? 'lookup' : 'clear', 'service', 'zeta-dev', 'account', account]);
  }
  throw failure('当前系统没有支持的凭证库。', 'VAULT');
}
export async function probeVault() {
  const key = 'probe:' + randomUUID();
  try { await vault('set', key, 'zeta-vault-probe'); if ((await vault('get', key)).trimEnd() !== 'zeta-vault-probe') throw failure('系统凭证库检查失败。', 'VAULT'); }
  finally { await vault('delete', key).catch(() => {}); }
}
