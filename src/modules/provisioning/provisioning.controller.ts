import { Controller, Post, Get, Param, Query } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';

@Controller('provisioning')
export class ProvisioningController {
  constructor(private readonly provisioningService: ProvisioningService) {}

  /**
   * Provisiona o banco de dados para um tenant
   */
  @Post('tenant/:tenantId')
  provisionTenant(@Param('tenantId') tenantId: string) {
    return this.provisioningService.provisionTenant(tenantId);
  }

  /**
   * Obtém a connection string de um tenant.
   * Query opcional: module=internal_chat (exige que o tenant tenha o módulo habilitado).
   */
  @Get('tenant/:tenantId/connection')
  getConnectionString(
    @Param('tenantId') tenantId: string,
    @Query('module') moduleCode?: string,
  ) {
    return this.provisioningService.getConnectionString(tenantId, moduleCode);
  }

  /**
   * Verifica a saúde do banco de um tenant
   */
  @Get('tenant/:tenantId/health')
  checkHealth(@Param('tenantId') tenantId: string) {
    return this.provisioningService.checkHealth(tenantId);
  }
}
