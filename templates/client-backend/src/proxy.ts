import { Router, Request, Response } from 'express';
import proxy from 'express-http-proxy';
import { getTenantIdFromRequest, requireAuth } from './auth';

const CORE_URL = (process.env.PAX_CORE_SERVICE_URL || '').replace(/\/$/, '');
const CHAT_URL = (process.env.PAX_CHAT_SERVICE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.PAX_SERVICE_KEY || '';

function tenantHeaderDecorator(proxyReqOpts: any, srcReq: Request): any {
  const tenantId = getTenantIdFromRequest(srcReq);
  if (tenantId) {
    proxyReqOpts.headers = { ...proxyReqOpts.headers, 'x-tenant-id': tenantId };
  }
  return proxyReqOpts;
}

function coreProxyDecorator(proxyReqOpts: any, srcReq: Request): any {
  const opts = tenantHeaderDecorator(proxyReqOpts, srcReq);
  if (SERVICE_KEY) {
    opts.headers = { ...opts.headers, 'x-service-key': SERVICE_KEY };
  }
  return opts;
}

export const proxyRouter = Router();

if (CORE_URL) {
  proxyRouter.use(
    '/core',
    requireAuth,
    proxy(CORE_URL, {
      proxyReqPathResolver: (req: Request) => (req.url || '').replace(/^\/core/, '') || '/',
      proxyReqOptDecorator: coreProxyDecorator,
    }) as any,
  );
} else {
  proxyRouter.use('/core', (_req: Request, res: Response) => {
    res.status(503).json({ message: 'PAX_CORE_SERVICE_URL não configurado' });
  });
}

if (CHAT_URL) {
  proxyRouter.use(
    '/chat',
    requireAuth,
    proxy(CHAT_URL, {
      proxyReqPathResolver: (req: Request) => (req.url || '').replace(/^\/chat/, '') || '/',
      proxyReqOptDecorator: tenantHeaderDecorator,
    }) as any,
  );
} else {
  proxyRouter.use('/chat', (_req: Request, res: Response) => {
    res.status(503).json({ message: 'PAX_CHAT_SERVICE_URL não configurado' });
  });
}
