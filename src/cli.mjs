#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { endpoint, failure, pair, request } from './api.mjs';
import { readProfile, saveProfile, account, forgetProfile } from './profiles.mjs';
import { vault, probeVault } from './vault.mjs';
import { doctor, bridge, withSourceClient, agentCommand } from './mcp.mjs';
import { downloadPreview, servePreview } from './preview.mjs';
import { projectCommand } from './project.mjs';
import { installProject } from './install.mjs';
import { spawn } from 'node:child_process';
import clientDefinitions from './clients.json' with {type:'json'};
const [command = 'help', ...args] = process.argv.slice(2);
const options = {};
const accepted = {
  install: ['--server', '--profile', '--ide', '--directory', '--web-origin'],
  connect: ['--server', '--profile', '--label', '--web-origin'],
  init: ['--profile', '--directory', '--game', '--revision', '--starter', '--name'],
  pull: ['--profile', '--directory'], status: ['--profile', '--directory'], push: ['--profile', '--directory'],
  preview: ['--profile', '--directory'], validate: ['--profile', '--directory'], 'save-version': ['--profile', '--directory', '--confirm-source'],
  'create-script': ['--profile', '--directory', '--scene', '--name'], 'delete-script': ['--profile', '--directory', '--path'],
  resume: ['--profile', '--directory', '--revision'], reconnect: ['--profile', '--directory', '--revision'],
  doctor: ['--profile'], mcp: ['--profile'], config: ['--profile', '--format'], forget: ['--profile'], help: [],
  tools:['--profile'],call:['--profile','--tool','--arguments'],
};
for (let i = 0; i < args.length;) {
  if (command === 'init' && i === 0 && !args[i].startsWith('--')) { options['--directory'] = args[i++]; continue; }
  if (!accepted[command]?.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) { process.stderr.write('参数无效。运行 help 查看用法。\n'); process.exit(2); }
  options[args[i]] = args[i + 1]; i += 2;
}
const name = options['--profile'] || 'default';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
async function connect(server, label) {
  await probeVault();
  const result = await pair({ server, label, webOrigin:options['--web-origin'], signal:controller.signal, onVerification:({verificationURL,expiresAt})=>{
    console.log('请在网页确认项目与权限，完成后会自动继续：\n'+verificationURL+'\n有效期至 '+expiresAt);
    const command=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?'rundll32':'xdg-open';
    const args=process.platform==='win32'?['url.dll,FileProtocolHandler',verificationURL]:[verificationURL];
    const child=spawn(command,args,{stdio:'ignore',detached:true});child.on('error',()=>{});child.unref();
  }});
  const profile={server,connectionId:result.connectionId,mcpUrl:result.mcpUrl,expiresAt:result.expiresAt};
  try {await vault('set',account(profile),result.token);await saveProfile(name,profile);}
  catch {await vault('delete',account(profile)).catch(()=>{});throw failure('授权保存失败。请在平台撤销连接 '+result.connectionId+' 后重试。','SAVE');}
  return profile;
}
async function main() {
  if(command==='install') {
    const server=endpoint(options['--server'],{originOnly:true});
    let profile=await readProfile(name);
    if(profile && (profile.server!==server || Date.parse(profile.expiresAt)<=Date.now()))throw failure('此连接名称已用于其他地址或已过期，请使用新的 --profile 名称。','PROFILE');
    const installed=await installProject({directory:options['--directory']||'.',ide:options['--ide']||'codex',profile:name,server});
    if(!profile)profile=await connect(server,options['--ide']||'Codex');
    const token=(await vault('get',account(profile))).trimEnd();
    const report=await doctor(profile.mcpUrl,token);
    console.log(JSON.stringify({...installed,connectionReady:report.authenticated,tools:report},null,2));
    console.log('接入文件已准备，网页授权和服务端工具可见性已核对。打开并信任项目，读取 zeta-game Skill；integration 中 project 项刷新 MCP，guided 项按官方指引导入 zeta-mcp.json，cli 项使用 tools/call。Agent 实际调用仍需在工具内确认。');
    return;
  }
  if (command === 'help') { console.log('zeta-dev install --ide '+clientDefinitions.map(client=>client.id).join('|')+' --server https://api.example.com [--web-origin https://studio.example.com] [--profile default] [--directory .]\nzeta-dev tools [--profile default]\nzeta-dev call --tool GAME_TOOL --arguments JSON_OBJECT [--profile default]\nzeta-dev connect --server https://api.example.com [--profile default] [--label Codex] [--web-origin https://studio.example.com]\nzeta-dev doctor [--profile default]\nzeta-dev mcp [--profile default]\nzeta-dev config [--profile default] [--format codex|cursor|claude|json]\nzeta-dev forget [--profile default]\nzeta-dev init [directory] --starter pixi-orbit-v1 --name 游戏名 [--profile default]\nzeta-dev init [directory] --game GAME_HANDLE --revision 1 [--profile default]\nzeta-dev status|pull|push|validate|preview [--directory .] [--profile default]\nzeta-dev save-version [--confirm-source sha256:...] [--directory .] [--profile default]\nzeta-dev create-script --scene SCENE_ID --name helper.js [--directory .]\nzeta-dev delete-script --path scripts/PATH.js [--directory .]\nzeta-dev reconnect --profile NEW_PROFILE [--revision 2] [--directory .]\nzeta-dev resume [--revision 2] [--directory .] [--profile default]\n源码版本：先在 tools/zeta-dev 执行 npm ci，再用 node src/cli.mjs 运行。'); return; }
  if (command === 'connect') {
    const server = endpoint(options['--server'], { originOnly: true });
    if (await readProfile(name)) throw failure('此连接名称已存在，请选择其他 --profile 名称；旧连接可在平台撤销。', 'PROFILE');
    await connect(server,options['--label']||'Zeta CLI');
    console.log('授权已保存至系统凭证库。运行 doctor 检查 MCP；这不代表你的 Agent 已连接。'); return;
  }
  const profile = await readProfile(name);
  if (!profile) throw failure('尚未建立此连接，请先运行 connect。', 'PROFILE');
  if (command === 'forget') { await vault('delete', account(profile)); await forgetProfile(name, profile); console.log('本机连接已移除。远端授权未撤销，请在平台连接管理中撤销不用的连接。'); return; }
  if (command === 'config') {
    const format = options['--format'] || 'json';
    if (!['json', 'codex', 'cursor', 'claude'].includes(format)) throw failure('配置格式无效：json、codex、cursor、claude。', 'FORMAT');
    const server = { command: process.execPath, args: [fileURLToPath(import.meta.url), 'mcp', '--profile', name] };
    console.log(format === 'codex'
      ? '[mcp_servers.zeta]\ncommand = ' + JSON.stringify(server.command) + '\nargs = ' + JSON.stringify(server.args)
      : JSON.stringify({ mcpServers: { zeta: format === 'json' ? server : { type: 'stdio', ...server } } }, null, 2));
    return;
  }
  if (!['doctor', 'mcp', 'tools', 'call', 'init', 'pull', 'status', 'push', 'validate', 'save-version', 'resume', 'reconnect', 'create-script', 'delete-script', 'preview'].includes(command)) throw failure('未知命令。运行 help 查看用法。', 'COMMAND');
  if (Date.parse(profile.expiresAt) <= Date.now()) throw failure('连接已过期，请重新配对。', 'EXPIRED');
  const token = (await vault('get', account(profile))).trimEnd();
  if (!/^cdev_[A-Za-z0-9_-]{43}$/.test(token)) throw failure('凭证库中没有有效 token，请重新配对。', 'VAULT');
  if (command === 'doctor') { const result = await doctor(profile.mcpUrl, token); console.log(JSON.stringify(result, null, 2)); if (!result.sourceToolsAvailable || !result.toolsComplete) process.exitCode = 1; return; }
  if (command === 'tools' || command === 'call') {
    let argumentsValue;
    if(command==='call'){
      const raw=options['--arguments'];
      if(!options['--tool'] || !raw || Buffer.byteLength(raw)>1024*1024)throw failure('call 需要 --tool 与不超过 1 MB 的 --arguments JSON 对象。','INPUT');
      try {argumentsValue=JSON.parse(raw);}catch{throw failure('--arguments 必须是有效 JSON。','INPUT');}
      if(!argumentsValue || typeof argumentsValue!=='object' || Array.isArray(argumentsValue))throw failure('--arguments 必须是 JSON 对象。','INPUT');
    }
    const result=await agentCommand(profile.mcpUrl,token,{name:command==='call'?options['--tool']:undefined,arguments:argumentsValue,signal:controller.signal});
    console.log(JSON.stringify(result,null,2));if(result.ok===false)process.exitCode=1;return;
  }
  if (['init', 'pull', 'status', 'push', 'validate', 'save-version', 'resume', 'reconnect', 'create-script', 'delete-script', 'preview'].includes(command)) {
    const result = await withSourceClient(profile.mcpUrl, token, call => projectCommand(command, {
      directory: options['--directory'] || '.', profile,
      options: { game: options['--game'], revision: options['--revision'], starter: options['--starter'], name: options['--name'], confirmSource: options['--confirm-source'], scene: options['--scene'], path: options['--path'] },
      call, signal: controller.signal, report: value => process.stderr.write(JSON.stringify(value) + '\n'),
      http: (server, path, body, settings) => request(server, path, body, { ...settings, token }),
    }), { signal: controller.signal });
    if (result.preview) {
      const artifact = await downloadPreview(profile.server, token, result.preview, { signal: controller.signal });
      await servePreview({ ...artifact, sourceHash: result.preview.expectedSourceHash, signal: controller.signal, onReady: value => console.log(JSON.stringify(value)) }); return;
    }
    console.log(JSON.stringify(result, null, 2)); if (result.validated === false) process.exitCode = 1; return;
  }
  await bridge(profile.mcpUrl, token, { signal: controller.signal, diagnostic: text => process.stderr.write(text + '\n') });
}
main().catch(error => { if (error.differences) process.stderr.write(JSON.stringify({ differences: error.differences }, null, 2) + '\n'); process.stderr.write((error.safeMessage || '操作失败，请检查本地依赖和服务状态。') + '\n'); process.exitCode = 1; });
