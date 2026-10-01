import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { endpoint, failure } from './api.mjs';

export async function downloadPreview(server, token, descriptor, { signal, fetchImpl = fetch } = {}) {
  let response;
  try { response = await fetchImpl(endpoint(server, { originOnly: true }) + '/api/v1/development/source-preview', {
    method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(descriptor), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  }); } catch { throw failure('预览下载失败，请检查服务连接。', 'NETWORK'); }
  if (!response.ok) throw failure('当前预览不可用，请检查授权并重新同步、验证源码。', 'PREVIEW');
  const expected = response.headers.get('x-artifact-sha256');
  if (!/^[a-f0-9]{64}$/.test(expected || '') || !response.body) throw failure('预览回执无效。', 'RECEIPT');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 64 * 1024 * 1024) throw failure('预览产物过大。', 'RECEIPT'); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = Buffer.concat(chunks);
  if (!size || createHash('sha256').update(bytes).digest('hex') !== expected) throw failure('预览产物摘要不匹配。', 'RECEIPT');
  let html; try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw failure('预览内容编码无效。', 'RECEIPT'); }
  return { html, artifactHash: expected };
}
const escape = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export async function servePreview({ html, sourceHash, artifactHash, signal, onReady = () => {} }) {
  if (signal?.aborted) throw failure('预览已取消。', 'CANCELLED');
  const route = '/' + randomBytes(24).toString('hex');
  const page = Buffer.from('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zeta 本地预览</title><link rel="icon" href="data:,"><style>html,body{margin:0;height:100%;background:#121418;color:#eee;font:14px system-ui}body{display:flex;flex-direction:column}header{padding:10px 16px}@media(prefers-color-scheme:light){html,body{background:#f7f8fa;color:#20242a}}iframe{border:0;width:100%;flex:1;background:white}</style><header>已验证源码快照 · 修改后请重新同步并运行 preview · Ctrl+C 关闭</header><iframe title="游戏预览" sandbox="allow-scripts allow-pointer-lock" allow="autoplay; fullscreen" srcdoc="' + escape(html) + '"></iframe></html>');
  let host;
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== route || req.headers.host !== host || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }); res.end(page);
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  host = '127.0.0.1:' + server.address().port;
  const close = () => { server.close(); server.closeAllConnections(); };
  try {
    const ended = new Promise(resolve => server.once('close', resolve));
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close(); else await onReady({ url: 'http://' + host + route, sourceHash, artifactHash, snapshot: true });
    await ended;
  } finally { signal?.removeEventListener('abort', close); close(); }
}
