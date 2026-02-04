import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { adminPrisma } from '@modulys-pax/admin-database';
import { TenantService } from '../tenant/tenant.service';
import { Client } from 'pg';

/** Código seguro para identificadores SQL: apenas [a-zA-Z0-9-], 1-63 chars. */
const SAFE_TENANT_CODE_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;

@Injectable()
export class ProvisioningService {
  constructor(
    private readonly configService: ConfigService,
    private readonly tenantService: TenantService,
  ) {}

  /**
   * Provisiona o banco de dados para um tenant
   * Cria o banco de dados e executa as migrations
   */
  async provisionTenant(tenantId: string) {
    const tenant = await this.tenantService.findById(tenantId);

    if (tenant.isProvisioned) {
      throw new BadRequestException('Tenant já foi provisionado');
    }
    if (!SAFE_TENANT_CODE_REGEX.test(tenant.code)) {
      throw new BadRequestException(
        'Código do tenant inválido para provisioning. Use apenas letras, números e hífen.',
      );
    }

    // Configurações do banco admin (para criar novos bancos)
    const adminHost = this.configService.get('DB_ADMIN_HOST', 'localhost');
    const adminPort = this.configService.get('DB_ADMIN_PORT', '5432');
    const adminUser = this.configService.get('DB_ADMIN_USER', 'postgres');
    const adminPass = this.configService.get('DB_ADMIN_PASS', 'postgres');

    // Nome do banco do tenant (ex: translog_erp, express_erp)
    const dbName = `${tenant.code.replace(/-/g, '_')}_erp`;
    const dbUser = `user_${tenant.code.replace(/-/g, '_')}`;
    const dbPass = this.generatePassword();

    // Conecta ao PostgreSQL como admin
    const client = new Client({
      host: adminHost,
      port: parseInt(adminPort),
      user: adminUser,
      password: adminPass,
      database: 'postgres',
    });

    try {
      await client.connect();

      // Cria o usuário do tenant
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${dbUser}') THEN
            CREATE USER ${dbUser} WITH PASSWORD '${dbPass}';
          END IF;
        END
        $$;
      `);

      // Cria o banco de dados
      const dbExists = await client.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName],
      );

      if (dbExists.rows.length === 0) {
        await client.query(`CREATE DATABASE ${dbName} OWNER ${dbUser}`);
      }

      // Fecha conexão atual e conecta ao novo banco para dar permissões
      await client.end();

      const tenantClient = new Client({
        host: adminHost,
        port: parseInt(adminPort),
        user: adminUser,
        password: adminPass,
        database: dbName,
      });

      await tenantClient.connect();

      // Dá permissões completas ao usuário no schema public
      await tenantClient.query(`
        GRANT ALL ON SCHEMA public TO ${dbUser};
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${dbUser};
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${dbUser};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${dbUser};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${dbUser};
      `);

      await tenantClient.end();

      // Atualiza o tenant com as credenciais do banco
      await adminPrisma.tenant.update({
        where: { id: tenantId },
        data: {
          databaseHost: adminHost,
          databasePort: parseInt(adminPort),
          databaseName: dbName,
          databaseUser: dbUser,
          databasePass: this.encrypt(dbPass), // TODO: Implementar criptografia real
          isProvisioned: true,
          provisionedAt: new Date(),
        },
      });

      return {
        success: true,
        database: {
          host: adminHost,
          port: parseInt(adminPort),
          name: dbName,
          user: dbUser,
        },
        message: 'Banco de dados provisionado com sucesso. Execute as migrations manualmente.',
        connectionString: `postgresql://${dbUser}:${dbPass}@${adminHost}:${adminPort}/${dbName}?schema=public`,
      };
    } catch (error) {
      console.error('Erro ao provisionar banco:', error);
      throw new BadRequestException('Erro ao provisionar banco de dados');
    }
  }

  /**
   * Remove o banco de dados e usuário de um tenant
   * CUIDADO: Esta operação é irreversível!
   */
  async deprovisionTenant(tenantId: string) {
    const tenant = await this.tenantService.findById(tenantId);

    if (!tenant.isProvisioned) {
      return { success: true, message: 'Tenant não estava provisionado' };
    }

    const dbName = tenant.databaseName;
    const dbUser = tenant.databaseUser;

    if (!dbName || !dbUser) {
      throw new BadRequestException('Dados do banco incompletos');
    }

    // Configurações do banco admin
    const adminHost = this.configService.get('DB_ADMIN_HOST', 'localhost');
    const adminPort = this.configService.get('DB_ADMIN_PORT', '5432');
    const adminUser = this.configService.get('DB_ADMIN_USER', 'postgres');
    const adminPass = this.configService.get('DB_ADMIN_PASS', 'postgres');

    const client = new Client({
      host: adminHost,
      port: parseInt(adminPort),
      user: adminUser,
      password: adminPass,
      database: 'postgres',
    });

    try {
      await client.connect();

      // Desconecta todas as sessões ativas do banco
      await client.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${dbName}'
        AND pid <> pg_backend_pid();
      `);

      // Drop do banco de dados
      const dbExists = await client.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName],
      );

      if (dbExists.rows.length > 0) {
        await client.query(`DROP DATABASE ${dbName}`);
        console.log(`Database ${dbName} dropped successfully`);
      }

      // Drop do usuário
      const userExists = await client.query(
        `SELECT 1 FROM pg_roles WHERE rolname = $1`,
        [dbUser],
      );

      if (userExists.rows.length > 0) {
        await client.query(`DROP USER ${dbUser}`);
        console.log(`User ${dbUser} dropped successfully`);
      }

      await client.end();

      return {
        success: true,
        message: `Banco '${dbName}' e usuário '${dbUser}' removidos com sucesso`,
        droppedDatabase: dbName,
        droppedUser: dbUser,
      };
    } catch (error: any) {
      console.error('Erro ao remover banco:', error);
      await client.end().catch(() => {});
      throw new BadRequestException(`Erro ao remover banco de dados: ${error.message}`);
    }
  }

  /**
   * Retorna a connection string do tenant.
   * Se moduleCode for informado, exige que o tenant tenha o módulo habilitado e esteja ativo.
   */
  async getConnectionString(tenantId: string, moduleCode?: string) {
    const tenant = await this.tenantService.findByIdOrCode(tenantId);

    if (!tenant.isProvisioned) {
      throw new BadRequestException('Tenant ainda não foi provisionado');
    }

    if (moduleCode) {
      if (tenant.status !== 'ACTIVE' && tenant.status !== 'TRIAL') {
        throw new ForbiddenException('Tenant não está ativo');
      }
      const hasModule = (tenant as any).modules?.some(
        (tm: { module: { code: string }; isEnabled: boolean }) =>
          tm.module.code === moduleCode && tm.isEnabled,
      );
      if (!hasModule) {
        throw new ForbiddenException(`Módulo ${moduleCode} não está habilitado para este tenant`);
      }
    }

    const pass = this.decrypt(tenant.databasePass!);
    const encodedPass = encodeURIComponent(pass);
    const port = Number(tenant.databasePort) || 5432;

    return {
      connectionString: `postgresql://${tenant.databaseUser}:${encodedPass}@${tenant.databaseHost}:${port}/${tenant.databaseName}?schema=public`,
    };
  }

  /**
   * Verifica a saúde do banco de um tenant
   */
  async checkHealth(tenantId: string) {
    const tenant = await this.tenantService.findByIdOrCode(tenantId);

    if (!tenant.isProvisioned) {
      return { healthy: false, message: 'Tenant não provisionado' };
    }

    const pass = this.decrypt(tenant.databasePass!);

    const client = new Client({
      host: tenant.databaseHost!,
      port: tenant.databasePort!,
      user: tenant.databaseUser!,
      password: pass,
      database: tenant.databaseName!,
      connectionTimeoutMillis: 5000,
    });

    try {
      await client.connect();
      await client.query('SELECT 1');
      return { healthy: true, message: 'Conexão OK' };
    } catch (error) {
      return { healthy: false, message: 'Falha na conexão', error: (error as Error).message };
    } finally {
      await client.end().catch(() => {});
    }
  }

  private generatePassword(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
    let password = '';
    for (let i = 0; i < 24; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  // TODO: Implementar criptografia real (ex: AES-256)
  private encrypt(text: string): string {
    return Buffer.from(text).toString('base64');
  }

  private decrypt(encrypted: string): string {
    return Buffer.from(encrypted, 'base64').toString('utf-8');
  }
}
