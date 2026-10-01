import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { failure } from './api.mjs';
import { validateFileList } from './source-snapshot.mjs';

const statePath = '.zeta/state.json';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (workspace, args) => workspace?.workspaceHandle === args.workspaceHandle && workspace.workspaceVersion === args.expectedWorkspaceVersion && workspace.sourceHash === args.expectedSourceHash;
const published = (workspace, args) => workspace?.status === 'published' && workspace.workspaceHandle === args.workspaceHandle && workspace.workspaceVersion === args.expectedWorkspaceVersion + 1 && workspace.sourceHash === args.expectedSourceHash;
const invalid = () => failure('验证或保存回执与当前源码不一致，恢复记录已保留。', 'RECEIPT');
const rejected = error => ['source_conflict', 'invalid_argument', 'protected_file', 'source_script_syntax'].includes(error.code);

async function currentWorkspace(state, call) {
  const listed = validateFileList(await call('file_list', { workspaceHandle: state.workspace.workspaceHandle }), state.workspace.workspaceHandle);
  if (listed.workspace.sourceHash !== state.workspace.sourceHash || listed.workspace.workspaceVersion !== state.workspace.workspaceVersion || JSON.stringify(listed.files) !== JSON.stringify(state.files)) throw failure('远端源码与本地同步基线不同，请先处理差异并 pull。', 'source_conflict');
  return listed.workspace;
}
function checkStatus(status, handle) {
  if (typeof status?.validationHandle !== 'string' || !/^sv1_[A-Za-z0-9_-]{32}$/.test(status.validationHandle) || (handle && status.validationHandle !== handle) || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'].includes(status.status)) throw invalid();
  return status;
}
function accepted(status, args) {
  if (status.status !== 'succeeded' || status.current !== true || !same(status.workspace, args) || status.workspace.status !== 'open' || status.workspace.validated !== true || !hex(status.workspace.validationReceiptHash)) throw failure('当前源码尚未取得有效验证回执，请运行 validate。', 'VALIDATION_REQUIRED');
  return status.workspace;
}

export async function validateProject(fs, state, call, { signal, report = () => {}, wait = (ms) => delay(ms, undefined, { signal }), now = Date.now } = {}) {
  const started = now();
  // Only retry explicit throttling/unavailability. Unknown transport outcomes
  // return to the caller; the persisted request/handle owns a later resumption.
  const request = async (tool, args) => {
    for (;;) {
      if (signal?.aborted) throw failure('验证等待已取消；远端任务和本地恢复信息保留。', 'CANCELLED');
      if (now() - started >= 15 * 60 * 1000) throw failure('验证仍未结束，请重新运行 validate 查询原任务。', 'VALIDATING');
      try { return await call(tool, args); }
      catch (error) {
        if (!error.retryable || error.code !== 'temporarily_unavailable') throw error;
        const retry = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 2000;
        if (retry > 60000) throw error;
        report({ validation: 'waiting', retryAfterMs: retry }); await wait(Math.max(1000, retry));
      }
    }
  };
  const current = await currentWorkspace(state, request);
  let validation = state.validation;
  if (!validation || !same(current, validation.args) || ['failed', 'cancelled', 'expired'].includes(validation.lastStatus)) {
    validation = { args: { workspaceHandle: current.workspaceHandle, requestId: randomUUID(), expectedWorkspaceVersion: current.workspaceVersion, expectedSourceHash: current.sourceHash } };
    state.validation = validation; await fs.writeJSON(statePath, state);
  }
  if (!validation.handle) {
    let status;
    try { status = checkStatus(await request('validation_start', validation.args)); }
    catch (error) { if (rejected(error)) { delete state.validation; await fs.writeJSON(statePath, state); } throw error; }
    validation.handle = status.validationHandle; await fs.writeJSON(statePath, state);
  }
  for (;;) {
    const status = checkStatus(await request('validation_status', { validationHandle: validation.handle }), validation.handle);
    validation.lastStatus = status.status;
    await fs.writeJSON(statePath, state);
    if (status.status === 'queued' || status.status === 'running') {
      const after = Number.isSafeInteger(status.pollAfterMs) && status.pollAfterMs > 0 ? status.pollAfterMs : 2000;
      if (after > 60000) throw invalid();
      report({ validation: status.status, pollAfterMs: after }); await wait(Math.max(1000, after)); continue;
    }
    if (status.status !== 'succeeded') {
      return { validated: false, validationStatus: status.status, errorCode: /^[a-z][a-z0-9_]{0,79}$/.test(status.errorCode || '') ? status.errorCode : 'validation_failed' };
    }
    const workspace = accepted(status, validation.args);
    state.workspace = workspace; await fs.writeJSON(statePath, state);
    return { validated: true, sourceHash: workspace.sourceHash, workspaceVersion: workspace.workspaceVersion, baseRevision: workspace.baseRevision, message: '验证通过。保存版本需显式运行 save-version --confirm-source ' + workspace.sourceHash };
  }
}

async function finishSave(fs, state, call) {
  const args = state.pendingSave || state.savedVersion?.args;
  if (!args || args.workspaceHandle !== state.workspace.workspaceHandle || args.gameHandle !== state.open.gameHandle || (!same(state.workspace, args) && !published(state.workspace, args)) || !hex(args.expectedValidationReceiptHash)) throw invalid();
  let result;
  try { result = await call('publish', args); }
  catch (error) { if (rejected(error) && state.pendingSave) { delete state.pendingSave; await fs.writeJSON(statePath, state); } throw error; }
  if (!published(result.workspace, args) || result.workspace.resultRevision !== result.revision || result.revision !== args.expectedActiveRevision + 1 || result.sourceHash !== args.expectedSourceHash || !hex(result.artifactHash)) throw invalid();
  state.workspace = result.workspace; state.savedVersion = { args, result }; delete state.pendingSave;
  await fs.writeJSON(statePath, state);
  return { saved: true, gameHandle: args.gameHandle, revision: result.revision, sourceHash: result.sourceHash, artifactHash: result.artifactHash, communityPublished: false, message: '版本已保存。继续编辑请运行 resume；发布到社区需回到平台单独操作。' };
}
export async function saveProjectVersion(fs, state, call, confirmSource) {
  if (state.pendingSave || state.savedVersion) {
    const args = state.pendingSave || state.savedVersion.args;
    if (confirmSource && confirmSource !== args.expectedSourceHash) throw failure('确认摘要与原保存请求不同。', 'CONFIRMATION');
    return finishSave(fs, state, call);
  }
  if (!state.validation?.handle) throw failure('请先运行 validate 获取当前源码的验证回执。', 'VALIDATION_REQUIRED');
  const current = await currentWorkspace(state, call);
  const status = checkStatus(await call('validation_status', { validationHandle: state.validation.handle }), state.validation.handle);
  const workspace = accepted(status, state.validation.args);
  if (workspace.sourceHash !== current.sourceHash || workspace.workspaceVersion !== current.workspaceVersion || workspace.baseRevision !== state.open.baseRevision) throw invalid();
  if (workspace.writesUsed === 0) throw failure('此工作区没有源码修改，无需另存一个版本。', 'NO_CHANGES');
  if (confirmSource !== workspace.sourceHash) {
    if (confirmSource) throw failure('确认摘要已过期或不匹配，未保存版本。', 'CONFIRMATION');
    return { readyToSave: true, gameHandle: state.open.gameHandle, nextRevision: workspace.baseRevision + 1, sourceHash: workspace.sourceHash, message: '确认保存此源码时，加上 --confirm-source ' + workspace.sourceHash + '；不会发布到社区。' };
  }
  state.pendingSave = { workspaceHandle: workspace.workspaceHandle, gameHandle: state.open.gameHandle, expectedActiveRevision: workspace.baseRevision, expectedWorkspaceVersion: workspace.workspaceVersion, expectedSourceHash: workspace.sourceHash, expectedValidationReceiptHash: workspace.validationReceiptHash, requestId: randomUUID() };
  await fs.writeJSON(statePath, state);
  return finishSave(fs, state, call);
}

export async function savedProjectStatus(state, call) {
  const status = checkStatus(await call('validation_status', { validationHandle: state.validation.handle }), state.validation.handle);
  if (status.workspace?.resultRevision !== state.savedVersion.result.revision || !published(status.workspace, state.savedVersion.args)) throw invalid();
  return { gameHandle: state.open.gameHandle, savedRevision: status.workspace.resultRevision, workspaceStatus: 'published', message: '此工作区已保存。继续编辑请运行 resume。' };
}
