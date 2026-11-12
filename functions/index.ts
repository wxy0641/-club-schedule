import { createSiteContext, createDatabaseClient, errorResponse } from './_qoder/backend.mjs';
import { createApplication } from './router.mjs';
import { publicOrigin } from './http.mjs';

// 保留应用自己的 Cookie；本应用账号与会话完全自持，不使用平台身份，也没有身份回退。
const handle = createApplication({
  db: createDatabaseClient(),
  origin: publicOrigin(),
});

Deno.serve(async (request) => {
  let context;
  try {
    context = createSiteContext(request, { forwardApplicationCredentials: true });
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
