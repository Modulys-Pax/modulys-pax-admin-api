import { Controller, Post, Get, Body, Headers, HttpCode, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TenantAuthService, TenantLoginDto } from './tenant-auth.service';
import { Public } from '../auth/public.decorator';

/**
 * Autenticação de usuários do tenant (colaboradores).
 * Usado pelo backend do cliente para validar login do frontend.
 * Retorna JWT com tenantId, employeeId, companyId etc. para uso em x-tenant-id e contexto.
 */
@Controller('tenant-auth')
@Public()
export class TenantAuthController {
  constructor(private readonly tenantAuthService: TenantAuthService) {}

  @Throttle({ login: { limit: 10, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: TenantLoginDto) {
    return this.tenantAuthService.login(body);
  }

  /**
   * Retorna o usuário atual (com role e permissions) a partir do Bearer token.
   * O backend do cliente chama este endpoint em GET /auth/me repassando o token no header.
   */
  @Get('me')
  async me(@Headers('authorization') authorization: string | undefined) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) {
      throw new UnauthorizedException('Token não informado');
    }
    return this.tenantAuthService.getMe(token);
  }
}
