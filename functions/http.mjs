// HTTP 基础工具：固定来源校验、有界 JSON 读取、稳定错误对象与响应头。
// 应用身份只来自本应用自己的会话校验；不使用平台身份或任何身份回退。

// 部署时通过环境变量 APP_PUBLIC_ORIGIN 指定站点来源（例如 https://example.com）。
// 未配置时不猜测来源，相关写请求返回 application_auth_not_configured。
export function publicOrigin(env = globalThis.Deno?.env) {
  const value = env?.get?.('APP_PUBLIC_ORIGIN');
  return typeof value === 'string' ? value.trim() : '';
}
export const BODY_LIMIT_BYTES = 16384;

export class AppError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

const NO_STORE = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' };

export function json(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: { ...NO_STORE, ...extra } });
}

export function errorJson(code, status, extra = {}) {
  return json({ error: code }, status, extra);
}

export function binary(bytes, { contentType, filename }) {
  // HTTP 头只能放 ASCII；中文文件名通过 RFC 5987 的 filename* 传递，filename 仅作降级。
  const fallback = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return new Response(bytes, {
    status: 200,
    headers: {
      ...NO_STORE,
      'content-type': contentType,
      'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'x-content-type-options': 'nosniff',
    },
  });
}

// 网关会把 app 段替换成部署的物理函数名，Provider 也可能先剥掉 /functions/v1。
export function applicationPath(request) {
  const match = new URL(request.url).pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
  if (!match) throw new AppError('not_found', 404);
  return match[1] || '/';
}

// 不安全方法必须来自固定来源；SameSite=Lax Cookie 之外的第二道 CSRF 防线。
export function requireTrustedOrigin(request, origin = publicOrigin()) {
  let configured;
  try { configured = new URL(origin); } catch { throw new AppError('application_auth_not_configured', 503); }
  if (configured.protocol !== 'https:' || configured.origin !== origin) {
    throw new AppError('application_auth_not_configured', 503);
  }
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  if (request.headers.get('origin') !== origin) throw new AppError('origin_forbidden', 403);
}

// 按实际流读取的字节数设上限，不信任 Content-Length。
export async function readJson(request, maxBytes = BODY_LIMIT_BYTES) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new AppError('invalid_input', 400);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('invalid_input', 400);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError('payload_too_large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AppError('invalid_input', 400);
  }
}

// 数据层错误只保留为稳定应用错误码，不泄露 Provider 细节。
export function rows(result) {
  if (result?.error || !Array.isArray(result?.data)) throw new AppError('database_unavailable', 503);
  return result.data;
}
