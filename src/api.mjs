export function failure(message, code = 'FAILED', status = 0) {
  return Object.assign(new Error(message), { safeMessage: message, code, status });
}
export function endpoint(raw, { originOnly = false } = {}) {
  let u; try { u = new URL(raw); } catch { throw failure('服务地址无效。', 'URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) || u.username || u.password || u.search || u.hash || (originOnly && !['', '/'].includes(u.pathname))) throw failure('地址必须是 HTTPS；本机联调可使用 loopback HTTP。', 'URL');
  return originOnly ? u.origin : u.href;
}
export async function request(server, path, body, { fetchImpl = fetch, signal, method = 'POST', token } = {}) {
  const origin = endpoint(server, { originOnly: true });
  if (!['GET', 'POST'].includes(method) || !/^\/api\/v1\/development\/[a-z0-9/-]+$/.test(path)) throw failure('请求地址无效。', 'URL');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let response;
  try { response = await fetchImpl(origin + path, { method, redirect: 'error', headers, body: method === 'GET' ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }); }
  catch { throw failure('无法连接服务，请检查地址、网络和 TLS。', 'NETWORK'); }
  let envelope; try { envelope = await response.json(); } catch { throw failure('服务响应格式无效。', 'RESPONSE', response.status); }
  if (!response.ok) throw failure('服务拒绝请求。', envelope?.code || 'HTTP', response.status);
  if (envelope?.data == null) throw failure('服务未返回有效结果。', 'RESPONSE');
  return envelope.data;
}
export async function pair({ server, label, webOrigin, onVerification, signal, fetchImpl, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const selectedOrigin = webOrigin ? endpoint(webOrigin, {originOnly:true}) : undefined;
  const start = await request(server, '/api/v1/development/pairings', { label, ...(selectedOrigin ? {webOrigin:selectedOrigin} : {}) }, { fetchImpl, signal });
  if (!/^[0-9a-f-]{36}$/.test(start.pairingId || '') || !/^[A-Za-z0-9_-]{43}$/.test(start.deviceSecret || '') || !Number.isFinite(Date.parse(start.expiresAt))) throw failure('配对响应无效。', 'RESPONSE');
  let verification; try { verification = new URL(start.verificationUrl); } catch { throw failure("配对地址无效。", "RESPONSE"); }
  if (verification.pathname !== '/local-development/pair' || verification.searchParams.get("pairingId") !== start.pairingId || [...verification.searchParams].length !== 1 || (selectedOrigin && verification.origin !== selectedOrigin)) throw failure("配对地址与所选平台不一致。", "RESPONSE");
  const verificationURL = verification.href; verification.search = ""; endpoint(verification.href);
  // Verification URLs contain the public pairing ID; deviceSecret never leaves the exchange body.
  await onVerification({ verificationURL, expiresAt: start.expiresAt });
  while (Date.now() < Date.parse(start.expiresAt)) {
    if (signal?.aborted) throw failure('连接已取消。', 'CANCELLED');
    try {
      const result = await request(server, `/api/v1/development/pairings/${start.pairingId}/exchange`, { deviceSecret: start.deviceSecret }, { fetchImpl, signal });
      const mcpURL = endpoint(result.mcpUrl);
      if (!/^cdev_[A-Za-z0-9_-]{43}$/.test(result.token || '') || new URL(mcpURL).origin !== new URL(server).origin || !/^[0-9a-f-]{36}$/.test(result.connectionId || '') || !Number.isFinite(Date.parse(result.expiresAt))) throw failure('凭证响应与目标服务不一致，请在平台撤销本次连接。', 'RESPONSE');
      return { ...result, mcpUrl: mcpURL };
    } catch (error) {
      if ([428, 429].includes(error.status)) { await wait(3000); continue; }
      if (error.code === 'NETWORK') throw failure('兑换响应未确认。请查看平台连接列表，必要时撤销本次连接后重新配对。', 'UNCERTAIN');
      if (error.status === 410) throw failure('配对已过期或取消，请重新连接。', 'EXPIRED');
      if (error.status === 409) throw failure('配对已消费或连接数量已达上限，请查看平台连接列表。', 'CONFLICT');
      throw error;
    }
  }
  throw failure('配对已过期，请重新连接。', 'EXPIRED');
}
