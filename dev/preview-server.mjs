// 本地预览：web/ 静态文件 + functions/router.mjs + 内存假数据库。
// 只用于前端状态回归；不连接真实 Provider，不代表部署环境行为。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../functions/router.mjs';
import { createFakeDb } from './fake-db.mjs';

const ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
// 生产来源校验只接受 https。本地预览在 http://localhost 打开，
// 适配层把转发请求的来源改写为配置来源，仅用于本地前端回归。
const ORIGIN = `https://localhost:${PORT}`;
const BROWSER_ORIGIN = `http://localhost:${PORT}`;

const UNIQUE = {
  users: [['id'], ['username']],
  sessions: [['token_digest']],
  auth_limiter: [['key']],
  spaces: [['id']],
  memberships: [['space_id', 'user_id']],
  schedules: [['id'], ['space_id', 'member_id']],
  space_invites: [['space_id'], ['code_hash']],
  invite_slots: [['id'], ['space_id', 'generation', 'slot_no'], ['space_id', 'claimed_by']],
  schedule_documents: [['id'], ['space_id', 'member_id']],
  space_teaching: [['space_id']],
  date_exceptions: [['id'], ['space_id', 'member_id', 'local_date', 'period']],
  calendar_consents: [['space_id', 'member_id']],
  collection_participants: [['space_id', 'user_id']],
  calendar_share_consents: [['space_id', 'member_id']],
  space_events: [['id']],
  event_assignments: [['id'], ['space_id', 'request_id', 'target_user_id']],
};

const db = createFakeDb({ writes: [] }, { unique: UNIQUE });
const handle = createApplication({ db, origin: ORIGIN });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, BROWSER_ORIGIN);
  if (url.pathname === '/functions/v1/app' || url.pathname.startsWith('/functions/v1/app/')) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    if (headers.has('origin')) headers.set('origin', ORIGIN);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await readBody(request);
    const forwarded = new Request(`${BROWSER_ORIGIN}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const result = await handle({ request: forwarded, requestId: 'local-preview' });
    response.statusCode = result.status;
    result.headers.forEach((value, key) => response.setHeader(key, value));
    response.end(Buffer.from(await result.arrayBuffer()));
    return;
  }

  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(ROOT, safe));
    response.statusCode = 200;
    response.setHeader('content-type', TYPES[extname(safe)] ?? 'application/octet-stream');
    response.setHeader('cache-control', 'no-store');
    response.end(data);
  } catch {
    response.statusCode = 404;
    response.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`preview ready ${ORIGIN}\n`);
});
