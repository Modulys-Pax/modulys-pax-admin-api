import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Client } from 'pg';
import * as bcrypt from 'bcrypt';
import { TenantService } from '../tenant/tenant.service';
import { ProvisioningService } from '../provisioning/provisioning.service';

export interface TenantLoginDto {
  tenantCode: string;
  email: string;
  password: string;
}

export interface TenantAuthPayload {
  sub: string;       // employeeId
  tenantId: string;
  companyId: string;
  branchId: string;
  roleId: string | null;
  email: string;
  name: string;
}

export interface TenantAuthResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    tenantId: string;
    companyId: string;
    branchId: string;
    roleId: string | null;
  };
}

@Injectable()
export class TenantAuthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly tenantService: TenantService,
    private readonly provisioningService: ProvisioningService,
  ) {}

  /**
   * Autentica um colaborador do tenant no banco do próprio tenant.
   * Usado pelo backend do cliente (gerado ou próprio) para login do frontend.
   */
  async login(dto: TenantLoginDto): Promise<TenantAuthResponse> {
    const { tenantCode, email, password } = dto;

    const tenant = await this.tenantService.findByCode(tenantCode);
    if (!tenant) {
      throw new UnauthorizedException('Tenant ou credenciais inválidos');
    }

    if (!tenant.isProvisioned) {
      throw new BadRequestException('Tenant ainda não foi provisionado');
    }

    if (tenant.status !== 'ACTIVE' && tenant.status !== 'TRIAL') {
      throw new UnauthorizedException('Tenant não está ativo');
    }

    const { connectionString } = await this.provisioningService.getConnectionString(tenant.id);
    const client = new Client({ connectionString });

    try {
      await client.connect();

      const result = await client.query<{
        id: string;
        name: string;
        email: string;
        password: string | null;
        companyId: string;
        branchId: string;
        roleId: string | null;
      }>(
        `SELECT id, name, email, password, "companyId", "branchId", "roleId"
         FROM employees
         WHERE email = $1 AND "hasSystemAccess" = true AND "isActive" = true
         LIMIT 1`,
        [email],
      );

      if (result.rows.length === 0) {
        throw new UnauthorizedException('Tenant ou credenciais inválidos');
      }

      const employee = result.rows[0];
      if (!employee.password) {
        throw new UnauthorizedException('Tenant ou credenciais inválidos');
      }

      const valid = await bcrypt.compare(password, employee.password);
      if (!valid) {
        throw new UnauthorizedException('Tenant ou credenciais inválidos');
      }

      const payload: TenantAuthPayload = {
        sub: employee.id,
        tenantId: tenant.id,
        companyId: employee.companyId,
        branchId: employee.branchId,
        roleId: employee.roleId,
        email: employee.email,
        name: employee.name,
      };

      const accessToken = this.jwtService.sign(payload as object);

      return {
        accessToken,
        user: {
          id: employee.id,
          email: employee.email,
          name: employee.name,
          tenantId: tenant.id,
          companyId: employee.companyId,
          branchId: employee.branchId,
          roleId: employee.roleId,
        },
      };
    } finally {
      await client.end().catch(() => {});
    }
  }
}
