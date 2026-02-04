import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

const rawJwtSecret = process.env.PAX_JWT_SECRET?.trim();
if (!rawJwtSecret) {
  throw new Error('PAX_JWT_SECRET is required. Set it in .env (same value as Admin API).');
}
const JWT_SECRET = rawJwtSecret;
const ADMIN_API_URL = (process.env.PAX_ADMIN_API_URL || '').replace(/\/$/, '');
const TENANT_CODE = process.env.PAX_TENANT_CODE || '';

export interface TenantPayload {
  sub: string;
  tenantId: string;
  companyId: string;
  branchId: string;
  roleId: string | null;
  roleName?: string;
  roleDescription?: string | null;
  email: string;
  name: string;
}

export function getTenantIdFromRequest(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const token = auth.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET) as TenantPayload;
    return decoded.tenantId || null;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: () => void): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Não autorizado' });
    return;
  }
  try {
    const token = auth.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET) as TenantPayload;
    (req as any).tenantUser = decoded;
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido ou expirado' });
  }
}

export const authRouter = Router();

authRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ message: 'Email e senha são obrigatórios' });
    return;
  }
  if (!ADMIN_API_URL || !TENANT_CODE) {
    res.status(500).json({ message: 'Backend não configurado (PAX_ADMIN_API_URL / PAX_TENANT_CODE)' });
    return;
  }
  try {
    const response = await fetch(`${ADMIN_API_URL}/tenant-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantCode: TENANT_CODE, email, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      res.status(response.status).json(data || { message: 'Erro ao autenticar' });
      return;
    }
    res.json(data);
  } catch (e: any) {
    res.status(502).json({ message: e?.message || 'Erro ao conectar na API' });
  }
});

authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Não autorizado' });
    return;
  }
  const token = auth.slice(7);
  if (!ADMIN_API_URL) {
    const user = (req as any).tenantUser as TenantPayload;
    return res.json({
      id: user.sub,
      email: user.email,
      name: user.name,
      tenantId: user.tenantId,
      companyId: user.companyId,
      branchId: user.branchId,
      roleId: user.roleId,
      role: {
        id: user.roleId || '',
        name: user.roleName || 'Usuário',
        description: user.roleDescription ?? null,
      },
      permissions: [],
    });
  }
  try {
    const response = await fetch(`${ADMIN_API_URL}/tenant-auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const fallback = (req as any).tenantUser as TenantPayload;
      return res.json({
        id: fallback.sub,
        email: fallback.email,
        name: fallback.name,
        tenantId: fallback.tenantId,
        companyId: fallback.companyId,
        branchId: fallback.branchId,
        roleId: fallback.roleId,
        role: {
          id: fallback.roleId || '',
          name: fallback.roleName || 'Usuário',
          description: fallback.roleDescription ?? null,
        },
        permissions: [],
      });
    }
    const userWithPermissions = await response.json();
    res.json(userWithPermissions);
  } catch (e: any) {
    const user = (req as any).tenantUser as TenantPayload;
    res.json({
      id: user.sub,
      email: user.email,
      name: user.name,
      tenantId: user.tenantId,
      companyId: user.companyId,
      branchId: user.branchId,
      roleId: user.roleId,
      role: {
        id: user.roleId || '',
        name: user.roleName || 'Usuário',
        description: user.roleDescription ?? null,
      },
      permissions: [],
    });
  }
});
