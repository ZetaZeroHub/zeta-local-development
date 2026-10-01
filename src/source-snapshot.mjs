import { createHash } from 'node:crypto';
import { failure } from './api.mjs';

export const hash = content => 'sha256:' + createHash('sha256').update(content).digest('hex');
const validHash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const invalid = () => failure('源码清单或文件校验失败，本地文件未更新。', 'SOURCE_INTEGRITY');

export function validateFileList(result, workspaceHandle) {
  const workspace = result?.workspace;
  if (workspace?.workspaceHandle !== workspaceHandle || !Number.isSafeInteger(workspace.workspaceVersion) || workspace.workspaceVersion < 1 || !validHash(workspace.sourceHash) || !Array.isArray(result.files) || result.files.length < 1 || result.files.length > 512) throw invalid();
  const seen = new Set(); let total = 0;
  for (const file of result.files) {
    // Portable relative paths only. Reserve CLI metadata and reject Windows
    // device names too, even when this checkout currently runs on macOS/Linux.
    if (typeof file.path !== 'string' || file.path.length > 240 || !file.path.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part) && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || file.path.split('/')[0].toLowerCase() === '.zeta') throw invalid();
    const key = file.path.toLowerCase();
    if (seen.has(key) || [...seen].some(other => other.startsWith(key + '/') || key.startsWith(other + '/'))) throw invalid();
    seen.add(key);
    if (typeof file.editable !== 'boolean' || !file.path.startsWith(file.editable ? 'scripts/' : 'project/') || !file.path.endsWith(file.editable ? '.js' : '.json') || !validHash(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 32 * 1024 * 1024) throw invalid();
    total += file.bytes;
    if (total > 64 * 1024 * 1024) throw invalid();
  }
  return result;
}

// Download into memory first: no partial file writes if a later page is stale,
// malformed, truncated, or belongs to a concurrent workspace mutation.
export async function readSnapshot(call, workspaceHandle) {
  const listing = validateFileList(await call('file_list', { workspaceHandle }), workspaceHandle);
  const contents = new Map();
  for (const file of listing.files) {
    const parts = []; let offset = 0;
    do {
      const page = await call('file_read', { workspaceHandle, path: file.path, offset, limit: 32768 });
      if (page.workspaceVersion !== listing.workspace.workspaceVersion || page.sourceHash !== listing.workspace.sourceHash) throw failure('远端源码在读取中发生变化，请重新拉取。', 'source_conflict');
      if (page.file?.path !== file.path || page.file.sha256 !== file.sha256 || page.file.bytes !== file.bytes || page.file.editable !== file.editable || typeof page.content !== 'string' || typeof page.end !== 'boolean') throw invalid();
      const bytes = Buffer.from(page.content, 'utf8');
      if (bytes.toString('utf8') !== page.content || bytes.length > 32768 || page.nextOffset !== offset + bytes.length || page.nextOffset > file.bytes || (!page.end && bytes.length === 0) || page.end !== (page.nextOffset === file.bytes)) throw invalid();
      parts.push(bytes); offset = page.nextOffset;
      if (page.end) break;
    } while (offset < file.bytes);
    const content = Buffer.concat(parts);
    if (content.length !== file.bytes || hash(content) !== file.sha256) throw invalid();
    contents.set(file.path, content);
  }
  // Also catch mutation between the last read and the end of this operation.
  const final = validateFileList(await call('file_list', { workspaceHandle }), workspaceHandle);
  if (JSON.stringify(final.files) !== JSON.stringify(listing.files) || final.workspace.workspaceVersion !== listing.workspace.workspaceVersion || final.workspace.sourceHash !== listing.workspace.sourceHash) throw failure('远端源码在读取中发生变化，请重新拉取。', 'source_conflict');
  return { ...listing, contents };
}
