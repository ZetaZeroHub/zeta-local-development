import { readFile, mkdir, lstat, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { failure } from './api.mjs';
import { launcher } from './release.mjs';
import clientDefinitions from './clients.json' with {type:'json'};

async function safePath(root, relative) {
  let current = root;
  for (const piece of relative.split('/')) {
    current = path.join(current, piece);
    try { if ((await lstat(current)).isSymbolicLink()) throw failure('安装路径不能包含符号链接。', 'INSTALL'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
async function existing(file) {
  try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw failure('配置文件不安全或超过 1 MB。', 'INSTALL'); return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function commit(file, original, next) {
  if (original === next) return;
  await mkdir(path.dirname(file), {recursive:true});
  if (await existing(file) !== original) throw failure('配置在安装期间发生变化，请重试。', 'INSTALL');
  if (original !== null) await writeFile(file + '.zeta-backup-' + randomUUID(), original, {flag:'wx',mode:0o600});
  const temporary = file + '.zeta-' + randomUUID();
  try { await writeFile(temporary, next, {flag:'wx',mode:0o600}); if (await existing(file) !== original) throw failure('配置已变化，请重试。', 'INSTALL'); await rename(temporary,file); }
  finally { await rm(temporary,{force:true}); }
}

// Project scope only. Existing settings are parsed and preserved semantically;
// a new TOML table is appended so existing comments and numeric types survive.
export async function installProject({directory='.', ide='codex', profile='default', server}) {
  const root = path.resolve(directory);
  await mkdir(root,{recursive:true});
  // Reject symlinks in every existing ancestor, including the caller's directory.
  let cursor = root; while (true) { if ((await lstat(cursor)).isSymbolicLink()) throw failure('项目目录不能是符号链接。','INSTALL'); const parent=path.dirname(cursor); if(parent===cursor)break;cursor=parent; }
  const clients=ide.split(',');
  if (!clients.length || new Set(clients).size!==clients.length || clients.some(value=>!clientDefinitions.some(client=>client.id===value))) throw failure('--ide 使用 '+clientDefinitions.map(client=>client.id).join('、')+'，可用逗号分隔。','INSTALL');
  const launch=launcher(profile), plans=[];
  for (const client of clients) {
    const definition=clientDefinitions.find(value=>value.id===client);
    const relative=definition.config||'zeta-mcp.json';
    const file=await safePath(root,relative), raw=await existing(file);
    let doc;
    try { doc=raw===null?{}:client==='codex'?parse(raw):JSON.parse(raw); }
    catch { throw failure('现有配置无法解析，未覆盖。请先修复配置。','INSTALL'); }
    if (!doc || typeof doc!=='object' || Array.isArray(doc)) throw failure('现有配置格式不正确。','INSTALL');
    const key=client==='codex'?'mcp_servers':'mcpServers';
    if (doc[key] && (typeof doc[key]!=='object' || Array.isArray(doc[key]))) throw failure('现有 MCP 配置格式不正确。','INSTALL');
    const wanted=client==='codex'?launch:{type:'stdio',...launch}, previous=doc[key]?.zeta;
    if (previous && !isDeepStrictEqual({...previous},wanted)) throw failure('已有 zeta MCP 配置不同，未覆盖。请保留旧配置并选择正确的连接。','INSTALL');
    if (!previous) {
      if (client==='codex') {
        const section=stringify({mcp_servers:{zeta:wanted}});
        const next=(raw||'')+'\n'+section;
        const parsed=parse(next); if(!isDeepStrictEqual({...parsed.mcp_servers.zeta},wanted))throw failure('配置核验失败。','INSTALL');
        plans.push({file,raw,next});
      } else { doc[key]={...(doc[key]||{}),zeta:wanted}; plans.push({file,raw,next:JSON.stringify(doc,null,2)+'\n'}); }
    }
  }
  const skillRoots=new Set(clients.map(client=>client==='claude'?'.claude/skills/zeta-game':'.agents/skills/zeta-game'));
  const source=new URL('../skills/zeta-game/',import.meta.url);
  const material=['SKILL.md','references/modes.md'];
  for(const skillRoot of skillRoots) {
    for(const name of material) {
      const file=await safePath(root,skillRoot+'/'+name),raw=await existing(file),next=await readFile(new URL(name,source),'utf8');
      if(raw!==null && raw!==next)throw failure('已有 zeta-game Skill 含本地修改，未覆盖。请先保存或改名。','INSTALL');
      plans.push({file,raw,next});
    }
    const file=await safePath(root,skillRoot+'/connection.json'),raw=await existing(file),next=JSON.stringify({profile,server},null,2)+'\n';
    if(raw!==null && raw!==next)throw failure('项目已关联其他连接，未覆盖。','INSTALL');
    plans.push({file,raw,next});
  }
  for(const plan of plans)await commit(plan.file,plan.raw,plan.next);
  return {directory:root,clients,files:plans.map(value=>path.relative(root,value.file)),skill:'zeta-game',needsClientRefresh:true,integration:clients.map(client=>{
    const definition=clientDefinitions.find(value=>value.id===client);
    return {client,kind:definition.kind,config:definition.config||'zeta-mcp.json',docs:definition.docs};
  })};
}
