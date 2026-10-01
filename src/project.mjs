import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { failure, request } from './api.mjs';
import { hash, readSnapshot, validateFileList } from './source-snapshot.mjs';
import { withProjectFiles } from './project-files.mjs';
import { validateProject, saveProjectVersion, savedProjectStatus } from './project-validation.mjs';

const statePath = '.zeta/state.json';
const stateError = () => failure('本地工程恢复信息无效或与当前连接不一致。请使用原连接，保留目录以便恢复。', 'LOCAL_STATE');
const localConflict = differences => Object.assign(failure('本地有未同步修改，文件已保留。请先查看 status 并处理差异。', 'LOCAL_CONFLICT'), { differences });
const digest = value => value === null ? null : hash(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

async function differences(fs, files) {
  const out = [];
  for (const file of files) {
    const current = await fs.read(file.path);
    if (digest(current) !== file.sha256) out.push({ path: file.path, kind: current === null ? 'deleted' : file.editable ? 'modified' : 'readonly-modified', bytes: current?.length || 0 });
  }
  return out;
}
async function publicProject(fs, state) {
  await fs.writeJSON('.zeta/project.json', {
    schemaVersion: 1, endpoint: state.server, projectId: state.projectId || null,
    gameHandle: state.open.gameHandle, baseRevision: state.savedVersion?.result.revision || state.open.baseRevision,
    sourceSchema: 'source-bundle-v1', files: state.files,
  });
}
async function resumePull(fs, state) {
  const pending = state.pendingPull;
  if (!pending) return;
  validateFileList(pending.listing, state.workspace.workspaceHandle);
  if (!Array.isArray(pending.entries) || pending.entries.length > 1024) throw stateError();
  const oldFiles = new Map(state.files.map(file => [file.path, file]));
  const newFiles = new Map(pending.listing.files.map(file => [file.path, file]));
  const expected = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const entries = [];
  for (const entry of pending.entries) {
    if (!expected.delete(entry.path) || entry.oldHash !== (oldFiles.get(entry.path)?.sha256 || null)) throw stateError();
    const file = newFiles.get(entry.path);
    const bytes = entry.content === null ? null : Buffer.from(entry.content, 'base64');
    if ((file && (!bytes || hash(bytes) !== file.sha256 || bytes.length !== file.bytes)) || (!file && bytes !== null)) throw stateError();
    const current = await fs.read(entry.path);
    if (digest(current) !== entry.oldHash && digest(current) !== digest(bytes)) throw localConflict([{ path: entry.path, kind: 'modified-during-pull' }]);
    entries.push({ ...entry, bytes });
  }
  if (expected.size) throw stateError();
  for (const entry of entries) {
    const current = await fs.read(entry.path);
    if (digest(current) === digest(entry.bytes)) continue;
    if (entry.bytes === null) await fs.remove(entry.path, entry.oldHash);
    else await fs.atomic(entry.path, entry.bytes, entry.oldHash);
  }
  const completed = { ...state, workspace: pending.listing.workspace, files: pending.listing.files };
  delete completed.pendingPull;
  await publicProject(fs, completed);
  await fs.writeJSON(statePath, completed);
  Object.assign(state, completed); delete state.pendingPull;
}
async function pull(fs, state, call) {
  const changed = await differences(fs, state.files);
  if (changed.length) throw localConflict(changed);
  const snapshot = await readSnapshot(call, state.workspace.workspaceHandle);
  const previous = new Map(state.files.map(file => [file.path, file]));
  const all = new Set([...previous.keys(), ...snapshot.contents.keys()]);
  const entries = [...all].map(path => ({ path, oldHash: previous.get(path)?.sha256 || null, content: snapshot.contents.get(path)?.toString('base64') ?? null }));
  state.pendingPull = { listing: { workspace: snapshot.workspace, files: snapshot.files }, entries };
  await fs.writeJSON(statePath, state);
  await resumePull(fs, state);
}
async function finishWrite(fs, state, call) {
  const pending = state.pendingWrite;
  if (!pending) return;
  const args = pending.args;
  const file = state.files.find(file => file.path === args?.path);
  if (!file?.editable || !uuid(args.requestId) || args.workspaceHandle !== state.workspace.workspaceHandle || args.expectedWorkspaceVersion !== state.workspace.workspaceVersion || args.expectedSourceHash !== state.workspace.sourceHash || args.expectedFileHash !== file.sha256 || typeof args.content !== 'string' || Buffer.byteLength(args.content) > 262144) throw stateError();
  let result;
  try { result = await call('file_update', args); }
  catch (error) {
    // These responses prove this particular mutation was rejected. Keep local
    // edits, but do not force the user to replay an obsolete rejected payload.
    if (['source_conflict', 'invalid_argument', 'protected_file', 'source_script_syntax'].includes(error.code)) {
      delete state.pendingWrite; await fs.writeJSON(statePath, state);
    }
    throw error;
  }
  if (result.file?.path !== file.path || result.file.sha256 !== hash(args.content) || result.file.bytes !== Buffer.byteLength(args.content) || !result.file.editable || result.workspaceVersion !== args.expectedWorkspaceVersion + 1 || !/^sha256:[a-f0-9]{64}$/.test(result.sourceHash || '')) throw failure('写入回执未确认，恢复请求已保留，请重试。', 'UNCERTAIN');
  const updated = { ...state, workspace: { ...state.workspace, workspaceVersion: result.workspaceVersion, sourceHash: result.sourceHash }, files: state.files.map(item => item.path === file.path ? result.file : item) };
  delete updated.pendingWrite;
  // State is the replay cache. Public metadata is regenerated on every command.
  await fs.writeJSON(statePath, updated);
  Object.assign(state, updated); delete state.pendingWrite;
}

async function reconnect(fs, state, profile, options, call) {
  if (!state.open || !state.workspace) throw failure('初始化尚未完成，请用原连接恢复 init。', 'INITIALIZING');
  validateFileList({ workspace: state.workspace, files: state.files }, state.workspace.workspaceHandle);
  if (state.pendingWrite || state.pendingSave || state.pendingStructure || state.pendingResume || (state.pendingPull && state.connectionId !== profile.connectionId)) throw failure('旧连接仍有结果未确认的操作。请先用原连接恢复原命令；原连接不可用时保留此目录，在新空目录接入已保存版本后手动合并。不会向新连接重放旧操作。', 'PENDING_OLD_CONNECTION');
  if (state.connectionId === profile.connectionId && !state.pendingReconnect) {
    validateFileList(await call('file_list', { workspaceHandle: state.workspace.workspaceHandle }), state.workspace.workspaceHandle);
    await resumePull(fs, state); await publicProject(fs, state);
    return { reconnected: true, gameHandle: state.open.gameHandle, baseRevision: state.open.baseRevision, local: await differences(fs, state.files), message: '工程已使用此连接。' };
  }
  const revision = options.revision ? Number(options.revision) : state.savedVersion?.result.revision || state.open.baseRevision;
  if (!Number.isSafeInteger(revision) || revision < 1) throw failure('续接版本必须是正整数。', 'INPUT');
  if (state.pendingReconnect && (state.pendingReconnect.connectionId !== profile.connectionId || state.pendingReconnect.open?.baseRevision !== revision || state.pendingReconnect.open?.gameHandle !== state.open.gameHandle || !uuid(state.pendingReconnect.open?.requestId))) throw stateError();
  if (!state.pendingReconnect) {
    state.pendingReconnect = { connectionId: profile.connectionId, open: { gameHandle: state.open.gameHandle, baseRevision: revision, requestId: randomUUID() } };
    await fs.writeJSON(statePath, state);
  }
  const pending = state.pendingReconnect;
  let workspace;
  try { workspace = await call('workspace_open', pending.open); }
  catch (error) {
    if (['source_conflict', 'invalid_argument', 'not_found', 'unauthorized', 'forbidden'].includes(error.code)) { delete state.pendingReconnect; await fs.writeJSON(statePath, state); }
    throw error;
  }
  if (workspace.gameHandle !== state.open.gameHandle || workspace.baseRevision !== revision) throw stateError();
  const remote = validateFileList(await call('file_list', { workspaceHandle: workspace.workspaceHandle }), workspace.workspaceHandle);
  if (!state.savedVersion && state.workspace.status !== 'published' && state.workspace.writesUsed > 0 && remote.workspace.sourceHash !== state.workspace.sourceHash) {
    delete state.pendingReconnect; await fs.writeJSON(statePath, state);
    throw failure('旧工作区含已推送但未保存的修改，文件已保留。请先保存版本；旧连接不可用时，在新目录接入保存版本并手动合并。', 'UNSAVED_VERSION');
  }
  const local = await differences(fs, state.files);
  if (local.length && JSON.stringify(remote.files) !== JSON.stringify(state.files)) throw localConflict(local);
  // Do not change local identity until the new credential has read the exact
  // game/version and conflicts have been checked. No old workspace is reused.
  state.connectionId = profile.connectionId; state.open = pending.open; state.workspace = remote.workspace;
  state.init = { kind: 'existing', gameHandle: state.open.gameHandle, baseRevision: revision };
  delete state.pendingReconnect; delete state.savedVersion; delete state.validation;
  await fs.writeJSON(statePath, state);
  if (!local.length) await pull(fs, state, call);
  await publicProject(fs, state);
  return { reconnected: true, gameHandle: state.open.gameHandle, baseRevision: revision, local: await differences(fs, state.files), message: '已使用新连接续接。旧连接未被自动撤销，可在平台连接管理中处理。' };
}

export async function projectCommand(command, { directory = '.', profile, options = {}, call, signal, report = () => {}, http = request }) {
  return withProjectFiles(directory, command === 'init', async fs => {
    let state = await fs.json(statePath);
    if (!state) {
      if (command !== 'init') throw stateError();
      await fs.assertFresh();
      await fs.atomic('.zeta/.gitignore', Buffer.from('state.json\nlock\nlock-*\n.zeta-tmp-*\n'));
      const entries = await fs.read('.zeta/project.json');
      if (entries) throw stateError();
      let init;
      if (options.game) {
        const revision = Number(options.revision);
        if (options.starter || !/^[A-Za-z0-9_-]{1,128}$/.test(options.game) || !Number.isSafeInteger(revision) || revision < 1) throw failure('已有项目需同时指定 --game 与正整数 --revision。', 'INPUT');
        init = { kind: 'existing', gameHandle: options.game, baseRevision: revision };
      } else {
        if (!options.starter || typeof options.name !== 'string' || !options.name || options.name.trim() !== options.name || Buffer.byteLength(options.name) > 120 || /\p{Cc}/u.test(options.name) || options.revision) throw failure('请选择 --starter 和 --name（名称不超过120字节、无首尾空格或控制字符），或使用 --game 与 --revision。', 'INPUT');
        const catalog = await http(profile.server, '/api/v1/development/starters', undefined, { method: 'GET', signal });
        const starter = catalog.items?.find(item => item.id === options.starter);
        if (!starter || !uuid(catalog.bootstrapRequestId) || catalog.bootstrapConsumed) throw failure('未取得本次创建授权，请在平台配对时批准创建一个项目。', 'CREATE_APPROVAL');
        init = { kind: 'starter', input: { bootstrapRequestId: catalog.bootstrapRequestId, requestId: randomUUID(), starterId: starter.id, starterDigest: starter.digest, name: options.name } };
      }
      state = { version: 1, server: profile.server, connectionId: profile.connectionId, init, files: [] };
      await fs.writeJSON(statePath, state);
    }
    if (state.version !== 1 || state.server !== profile.server || !Array.isArray(state.files)) throw stateError();
    if (command === 'reconnect') return reconnect(fs, state, profile, options, call);
    if (state.connectionId !== profile.connectionId) throw stateError();
    if (state.pendingReconnect) throw failure('更换连接结果尚未确认，请用目标连接重试 reconnect。', 'PENDING_RECONNECT');
    if (command === 'init' && ((options.game && options.game !== state.init.gameHandle) || (options.revision && Number(options.revision) !== state.init.baseRevision) || (options.starter && options.starter !== state.init.input?.starterId) || (options.name && options.name !== state.init.input?.name))) throw failure('初始化参数与已保存请求不同。请使用原参数恢复，或另选空目录。', 'LOCAL_STATE');
    if (!state.open) {
      if (command !== 'init') throw failure('初始化尚未完成，请重新运行 init。', 'INITIALIZING');
      let gameHandle = state.init.gameHandle, baseRevision = state.init.baseRevision;
      if (state.init.kind === 'starter') {
        let operation = await http(profile.server, '/api/v1/development/projects', state.init.input, { signal });
        const started = Date.now();
        while (operation.status === 'queued' || operation.status === 'running') {
          report({ initialization: operation.status });
          if (Date.now() - started > 15 * 60 * 1000) throw failure('初始化仍在进行，重新运行同一 init 可恢复查询。', 'INITIALIZING');
          await delay(2000, undefined, { signal });
          operation = await http(profile.server, '/api/v1/development/operations/' + state.init.input.bootstrapRequestId, undefined, { method: 'GET', signal });
        }
        if (operation.id !== state.init.input.bootstrapRequestId || operation.status !== 'succeeded' || !operation.gameHandle || operation.revision !== 1) throw failure('首版初始化未成功，当前请求已保留，请在平台查看初始化结果。', 'INITIALIZATION_FAILED');
        gameHandle = operation.gameHandle; baseRevision = operation.revision; state.projectId = operation.projectId;
      }
      state.open = { gameHandle, baseRevision, requestId: randomUUID() };
      await fs.writeJSON(statePath, state);
    }
    if (!state.workspace) {
      state.workspace = await call('workspace_open', state.open);
      if (state.workspace.gameHandle !== state.open.gameHandle || state.workspace.baseRevision !== state.open.baseRevision || !state.workspace.workspaceHandle) throw stateError();
      await fs.writeJSON(statePath, state);
    }
    if (state.files.length) validateFileList({ workspace: state.workspace, files: state.files }, state.workspace.workspaceHandle);
    if (state.pendingPull && !['init', 'pull', 'create-script', 'delete-script'].includes(command)) return { pendingPull: true, message: '上次拉取尚未完成，请重新运行 pull 恢复。' };
    await resumePull(fs, state);
    if (state.pendingWrite) {
      if (command !== 'push') return { pendingWrite: true, message: '上次推送结果未确认，请重新运行 push 恢复。', local: await differences(fs, state.files) };
      await finishWrite(fs, state, call);
    }
    if (state.pendingStructure && command !== state.pendingStructure.command) return { pendingStructure: true, message: '脚本操作结果尚未确认，请重试 '+state.pendingStructure.command+'。' };
    if (state.pendingSave && command !== 'save-version') return { pendingSave: true, message: '上次保存结果未确认，请重新运行 save-version 恢复同一请求。' };
    if (state.savedVersion && command === 'status') return { ...await savedProjectStatus(state, call), local: await differences(fs, state.files) };
    if (state.savedVersion && !['save-version', 'resume'].includes(command)) throw failure('此工作区已保存，请运行 resume 继续编辑。', 'workspace_closed');
    if (command === 'create-script' || command === 'delete-script') {
      if (!state.pendingStructure) {
        const changed = await differences(fs, state.files); if (changed.length) throw localConflict(changed);
        const args = { workspaceHandle: state.workspace.workspaceHandle, requestId: randomUUID(), expectedWorkspaceVersion: state.workspace.workspaceVersion, expectedSourceHash: state.workspace.sourceHash };
        if (command === 'create-script') {
          if (!/^[A-Za-z][A-Za-z0-9._-]{0,59}\.js$/.test(options.name || '') || !state.files.some(file => file.sceneId === options.scene)) throw failure('请选择已有场景及合法的 JS 文件名。', 'INPUT');
          Object.assign(args, {sceneId: options.scene, name: options.name, content: '// New script\n'});
        } else {
          const file = state.files.find(file => file.path === options.path);
          if (!file?.editable || file.name === 'main.js' || state.files.filter(item => item.editable).length <= 1) throw failure('只能删除清单中的非核心脚本。', 'INPUT');
          Object.assign(args, {path:file.path, expectedFileHash:file.sha256});
        }
        state.pendingStructure={command,args}; await fs.writeJSON(statePath,state);
      }
      const pending=state.pendingStructure;
      if (pending.command!==command || pending.args.workspaceHandle!==state.workspace.workspaceHandle || !uuid(pending.args.requestId)) throw stateError();
      if ((options.name && options.name!==pending.args.name) || (options.scene && options.scene!==pending.args.sceneId) || (options.path && options.path!==pending.args.path)) throw failure('参数与待确认操作不同，请重试原命令。','LOCAL_STATE');
      let result;
      try { result=await call(command==='create-script'?'file_create':'file_delete',pending.args); }
      catch(error) {
        if (['source_conflict','invalid_argument','protected_file','source_script_syntax'].includes(error.code)) { delete state.pendingStructure; await fs.writeJSON(statePath,state); }
        throw error;
      }
      if (result.workspaceVersion!==pending.args.expectedWorkspaceVersion+1 || !/^sha256:[a-f0-9]{64}$/.test(result.sourceHash || '')) throw failure('脚本操作回执未确认，请重试原命令。','UNCERTAIN');
      // Keep the old local snapshot until the entire authoritative pull commits.
      // A retry can replay the same request even after the remote mutation won.
      await pull(fs,state,call);
      delete state.pendingStructure; delete state.validation;
      await fs.writeJSON(statePath,state); await publicProject(fs,state);
      return {operation:command, file:result.file, workspaceVersion:state.workspace.workspaceVersion, sourceHash:state.workspace.sourceHash};
    }
    if (command === 'resume') {
      const revision = options.revision ? Number(options.revision) : state.savedVersion?.result.revision || state.open.baseRevision;
      if (!Number.isSafeInteger(revision) || revision < 1 || (state.pendingResume && state.pendingResume.baseRevision !== revision)) throw failure('续接版本无效或与上次请求不同。', 'INPUT');
      if (!state.pendingResume) { state.pendingResume = { gameHandle: state.open.gameHandle, baseRevision: revision, requestId: randomUUID() }; await fs.writeJSON(statePath, state); }
      let workspace;
      try { workspace = await call('workspace_open', state.pendingResume); }
      catch (error) {
        if (['source_conflict', 'invalid_argument', 'not_found'].includes(error.code)) { delete state.pendingResume; await fs.writeJSON(statePath, state); }
        throw error;
      }
      if (workspace.gameHandle !== state.open.gameHandle || workspace.baseRevision !== revision) throw stateError();
      const remote = validateFileList(await call('file_list', { workspaceHandle: workspace.workspaceHandle }), workspace.workspaceHandle);
      const local = await differences(fs, state.files);
      if (!state.savedVersion && state.workspace.status !== 'published' && state.workspace.writesUsed > 0 && remote.workspace.sourceHash !== state.workspace.sourceHash) {
        // "Clean" means synchronized to the workspace, not saved as a version.
        // Opening its older immutable base must not overwrite those edits.
        delete state.pendingResume; await fs.writeJSON(statePath, state);
        throw failure('当前源码已经推送，但尚未保存为版本。续接会丢失这些修改，文件已保留。请先验证并保存；原工作区已过期时，另建目录接入保存版本，再手动合并保留的源码。', 'UNSAVED_VERSION');
      }
      if (local.length && JSON.stringify(remote.files) !== JSON.stringify(state.files)) throw localConflict(local);
      state.open = state.pendingResume; state.workspace = remote.workspace;
      delete state.pendingResume; delete state.savedVersion; delete state.validation;
      await fs.writeJSON(statePath, state);
      if (local.length === 0) await pull(fs, state, call);
    }
    if (command === 'preview') {
      const local = await differences(fs, state.files); if (local.length) throw localConflict(local);
      const validation = await validateProject(fs, state, call, { signal, report });
      if (!validation.validated) return validation;
      return { preview: { workspaceHandle: state.workspace.workspaceHandle, expectedWorkspaceVersion: state.workspace.workspaceVersion, expectedSourceHash: state.workspace.sourceHash } };
    }
    if (command === 'validate' || command === 'save-version') {
      // An uncertain save may already have committed. Recover its original
      // receipt even if the user subsequently edited local files.
      if (!state.pendingSave && !state.savedVersion) {
        const local = await differences(fs, state.files); if (local.length) throw localConflict(local);
      }
      const result = command === 'validate' ? await validateProject(fs, state, call, { signal, report }) : await saveProjectVersion(fs, state, call, options.confirmSource);
      await publicProject(fs, state); return result;
    }
    if (command === 'init' || command === 'pull') {
      await pull(fs, state, call);
      if (command === 'init') {
        if (await fs.read('.zeta/.gitignore') === null) await fs.atomic('.zeta/.gitignore', Buffer.from('state.json\nlock\nlock-*\n.zeta-tmp-*\n'), null);
        if (await fs.read('ZETA-README.md') === null) await fs.atomic('ZETA-README.md', Buffer.from('# 本地游戏工程\n\n编辑 scripts 下清单中的 JS 文件；工程 JSON 只读。使用 zeta-dev status 查看差异、push 同步源码、pull 拉取远端。额外本地文件不会上传。\n\n源码同步不代表已保存版本或已发布到社区。凭证在系统凭证库，.zeta/state.json 是忽略提交的恢复缓存，请保留以便恢复中断命令。\n'), null);
      }
    } else if (command === 'push') {
      const remote = validateFileList(await call('file_list', { workspaceHandle: state.workspace.workspaceHandle }), state.workspace.workspaceHandle);
      if (remote.workspace.workspaceVersion !== state.workspace.workspaceVersion || remote.workspace.sourceHash !== state.workspace.sourceHash) throw failure('远端源码已修改，请先查看 status 并处理远端差异。', 'source_conflict');
      const changes = await differences(fs, state.files);
      if (changes.some(item => item.kind !== 'modified' || item.bytes > 262144)) throw localConflict(changes);
      for (const change of changes) {
        const file = state.files.find(item => item.path === change.path);
        const bytes = await fs.read(file.path); const content = bytes?.toString('utf8');
        if (!bytes || bytes.length > 262144 || !Buffer.from(content, 'utf8').equals(bytes)) throw localConflict([change]);
        if (hash(bytes) === file.sha256) continue;
        state.pendingWrite = { args: { workspaceHandle: state.workspace.workspaceHandle, requestId: randomUUID(), expectedWorkspaceVersion: state.workspace.workspaceVersion, expectedSourceHash: state.workspace.sourceHash, expectedFileHash: file.sha256, path: file.path, content } };
        await fs.writeJSON(statePath, state); await finishWrite(fs, state, call);
      }
      // JS writes also update server-owned scene references. Refresh that exact
      // canonical snapshot after all writes, preserving any new local edits.
      if ((await differences(fs, state.files)).length === 0) await pull(fs, state, call);
    }
    await publicProject(fs, state);
    const remote = validateFileList(await call('file_list', { workspaceHandle: state.workspace.workspaceHandle }), state.workspace.workspaceHandle);
    return { gameHandle: state.open.gameHandle, baseRevision: state.open.baseRevision, workspaceVersion: state.workspace.workspaceVersion, remoteWorkspaceVersion: remote.workspace.workspaceVersion, remoteChanged: remote.workspace.sourceHash !== state.workspace.sourceHash || JSON.stringify(remote.files) !== JSON.stringify(state.files), local: await differences(fs, state.files), files: state.files.length };
  });
}
