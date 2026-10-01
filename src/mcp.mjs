import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { endpoint, failure } from './api.mjs';
function transport(url, token, onThrottle) {
  endpoint(url);
  return new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer ' + token }, redirect: 'error' }, ...(onThrottle ? { fetch: async (...args) => {
    const response = await fetch(...args);
    if (response.status === 429) {
      const raw = response.headers.get('retry-after');
      const ms = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - Date.now() : 2000;
      onThrottle(Number.isFinite(ms) ? Math.max(1000, ms) : 2000);
    }
    return response;
  } } : {}) });
}
// Keep server error codes for conflict/recovery decisions, but never print raw
// transport errors: they can contain request headers or private server paths.
export async function withSourceClient(url, token, action, { signal } = {}) {
  const client = new Client({ name: 'zeta-dev-source', version: '0.1.0' });
  let retryAfterMs = 2000;
  try {
    await client.connect(transport(url, token, ms => { retryAfterMs = ms; }), { timeout: 15000, signal });
    return await action(async (name, args) => {
      if (!['workspace_open', 'file_list', 'file_read', 'file_create', 'file_update', 'file_delete', 'validation_start', 'validation_status', 'publish', 'workspace_cancel'].includes(name)) throw failure('未知源码操作。', 'COMMAND');
      let result;
      try { result = await client.callTool({ name: 'game_source_' + name, arguments: args }, undefined, { timeout: 30000, signal }); }
      catch (error) {
        if (error.code === 429) throw Object.assign(failure('源码请求限流，请稍后重试。', 'temporarily_unavailable'), { retryable: true, retryAfterMs });
        throw failure('源码请求结果未确认，请保留本地恢复信息后重试。', 'UNCERTAIN');
      }
      const envelope = result.structuredContent;
      if (envelope?.ok === false && typeof envelope.error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(envelope.error.code)) {
        throw Object.assign(failure('源码服务拒绝请求：' + envelope.error.code, envelope.error.code), {
          retryable: envelope.error.retryable === true,
          retryAfterMs: Number.isSafeInteger(envelope.error.retryAfterMs) ? Math.max(0, envelope.error.retryAfterMs) : 0,
        });
      }
      if (result.isError || envelope?.ok !== true || !envelope.data || typeof envelope.data !== 'object') throw failure('源码服务响应格式无效。', 'RESPONSE');
      return envelope.data;
    });
  } catch (error) {
    if (error.safeMessage) throw error;
    throw failure('MCP 连接失败，请检查授权与服务状态。', 'MCP');
  } finally { await client.close().catch(() => {}); }
}
export async function doctor(url, token) {
  const client = new Client({ name: 'zeta-dev-doctor', version: '0.1.0' });
  try {
    await client.connect(transport(url, token), { timeout: 15000 });
    const names = new Set(); let cursor;
    for (let page = 0; page < 50; page++) { const result = await client.listTools(cursor ? { cursor } : {}); result.tools.forEach(t => names.add(t.name)); cursor = result.nextCursor; if (!cursor) break; }
    const required = ['game_source_workspace_open', 'game_source_file_list', 'game_source_file_read', 'game_source_validation_start', 'game_source_publish'];
    return { authenticated: true, toolsComplete: !cursor, sourceToolsAvailable: required.every(n => names.has(n)), missingTools: required.filter(n => !names.has(n)), toolCount: names.size };
  } catch { throw failure('MCP 初始化或工具列表检查失败，请检查连接是否过期、撤销或服务停用。', 'MCP'); }
  finally { await client.close().catch(() => {}); }
}
export async function bridge(url, token, { input = process.stdin, output = process.stdout, signal, diagnostic = () => {} } = {}) {
  const remote = transport(url, token); const local = new StdioServerTransport(input, output, { maxBufferSize: 1024 * 1024 });
  let closing = false, inFlight = 0, finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const close = async () => { if (closing) return; closing = true; await Promise.allSettled([remote.close(), local.close()]); input.off('end', close); signal?.removeEventListener('abort', close); finish(); };
  local.onmessage = async message => {
    if (closing) return;
    if (inFlight >= 32) { if ('id' in message) await local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Too many pending requests' } }); return; }
    inFlight++;
    try { await remote.send(message); }
    catch { if ('id' in message && !closing) await local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Remote MCP request failed; check connection authorization' } }); }
    finally { inFlight--; }
  };
  remote.onmessage = message => {
    if (message.result?.protocolVersion) remote.setProtocolVersion(message.result.protocolVersion);
    local.send(message).catch(close);
  };
  local.onerror = () => { diagnostic('本地 MCP 消息无效。'); void close(); };
  remote.onerror = () => diagnostic('远端 MCP 请求失败。');
  local.onclose = close; remote.onclose = close;
  input.once('end', close); signal?.addEventListener('abort', close, { once: true });
  try { await remote.start(); await local.start(); if (signal?.aborted) await close(); await ended; }
  finally { await close(); }
}
