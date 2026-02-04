import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
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

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: TenantLoginDto) {
    return this.tenantAuthService.login(body);
  }
}
