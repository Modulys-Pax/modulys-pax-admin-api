import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { adminPrisma, TenantStatus, Prisma, Module } from '@modulys-pax/admin-database';
import { Client } from 'pg';

/** Código do tenant: apenas letras, números e hífen (1-63 chars). Usado em identificadores SQL. */
const TENANT_CODE_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;

function validateTenantCode(code: string): void {
  if (!code || !TENANT_CODE_REGEX.test(code)) {
    throw new BadRequestException(
      'Código do tenant deve ter 1 a 63 caracteres: apenas letras, números e hífen.',
    );
  }
}

@Injectable()
export class TenantService {
  constructor(private readonly configService: ConfigService) {}
  async create(data: {
    code: string;
    name: string;
    tradeName?: string;
    document: string;
    email: string;
    phone?: string;
    notes?: string;
    planId?: string;      // Usar plano como template
    moduleIds?: string[]; // OU selecionar módulos manualmente
  }) {
    const { planId, moduleIds, ...tenantData } = data;

    // Verifica se já existe tenant com mesmo código ou documento
    const existing = await adminPrisma.tenant.findFirst({
      where: {
        OR: [{ code: tenantData.code }, { document: tenantData.document }],
      },
    });

    validateTenantCode(tenantData.code);

    if (existing) {
      throw new ConflictException(
        existing.code === tenantData.code
          ? 'Código já está em uso'
          : 'CNPJ já cadastrado',
      );
    }

    // Determina quais módulos serão habilitados
    let modulesToEnable: string[] = [];

    if (planId && moduleIds && moduleIds.length > 0) {
      throw new BadRequestException(
        'Informe planId OU moduleIds, não ambos. Use planId para usar um plano como template, ou moduleIds para seleção customizada.',
      );
    }

    if (planId) {
      // Busca módulos do plano
      const plan = await adminPrisma.plan.findUnique({
        where: { id: planId },
        include: { modules: { select: { moduleId: true } } },
      });

      if (!plan) {
        throw new NotFoundException('Plano não encontrado');
      }

      modulesToEnable = plan.modules.map((m: { moduleId: string }) => m.moduleId);
    } else if (moduleIds && moduleIds.length > 0) {
      // Valida se todos os módulos existem
      const modules = await adminPrisma.module.findMany({
        where: { id: { in: moduleIds }, isActive: true },
      });

      if (modules.length !== moduleIds.length) {
        throw new BadRequestException('Um ou mais módulos não foram encontrados');
      }

      modulesToEnable = moduleIds;
    }

    // Sempre adiciona módulos core
    const coreModules = await adminPrisma.module.findMany({
      where: { isCore: true, isActive: true },
    });
    
    const coreModuleIds = coreModules.map((m: Module) => m.id);
    modulesToEnable = [...new Set([...coreModuleIds, ...modulesToEnable])];

    // Cria tenant com módulos em uma transação
    return adminPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const tenant = await tx.tenant.create({
        data: {
          ...tenantData,
          status: TenantStatus.PENDING,
        },
      });

      // Cria os módulos do tenant
      if (modulesToEnable.length > 0) {
        await tx.tenantModule.createMany({
          data: modulesToEnable.map(moduleId => ({
            tenantId: tenant.id,
            moduleId,
            isEnabled: true,
          })),
        });
      }

      // Retorna tenant com módulos
      return tx.tenant.findUnique({
        where: { id: tenant.id },
        include: {
          modules: { include: { module: true } },
        },
      });
    });
  }

  async findAll(filters?: {
    status?: TenantStatus;
    search?: string;
  }) {
    const where = {
      ...(filters?.status && { status: filters.status }),
      ...(filters?.search && {
        OR: [
          { name: { contains: filters.search, mode: 'insensitive' as const } },
          { code: { contains: filters.search, mode: 'insensitive' as const } },
          { document: { contains: filters.search } },
        ],
      }),
    };

    return adminPrisma.tenant.findMany({
      where,
      include: {
        subscription: {
          include: { plan: true },
        },
        modules: {
          include: { module: true },
          where: { isEnabled: true },
        },
        _count: {
          select: { contacts: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    const tenant = await adminPrisma.tenant.findUnique({
      where: { id },
      include: {
        subscription: {
          include: {
            plan: true,
            invoices: {
              orderBy: { dueDate: 'desc' },
              take: 5,
            },
          },
        },
        modules: {
          include: { module: true },
        },
        contacts: true,
      },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant não encontrado');
    }

    return tenant;
  }

  async findByCode(code: string) {
    return adminPrisma.tenant.findUnique({
      where: { code },
      include: {
        modules: {
          include: { module: true },
          where: { isEnabled: true },
        },
      },
    });
  }

  /**
   * Busca tenant por id (UUID) ou por code. Útil para rotas que recebem identificador
   * que pode ser um ou outro (ex: provisioning/connection).
   */
  async findByIdOrCode(idOrCode: string) {
    const tenant = await adminPrisma.tenant.findFirst({
      where: {
        OR: [{ id: idOrCode }, { code: idOrCode }],
      },
      include: {
        subscription: {
          include: { plan: true },
        },
        modules: {
          include: { module: true },
        },
        contacts: true,
      },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant não encontrado');
    }

    return tenant;
  }

  async update(id: string, data: Partial<{
    name: string;
    tradeName: string;
    email: string;
    phone: string;
    status: TenantStatus;
    notes: string;
  }>) {
    await this.findById(id);

    return adminPrisma.tenant.update({
      where: { id },
      data,
    });
  }

  async updateStatus(id: string, status: TenantStatus) {
    await this.findById(id);

    return adminPrisma.tenant.update({
      where: { id },
      data: { status },
    });
  }

  async addContact(tenantId: string, data: {
    name: string;
    email: string;
    phone?: string;
    role?: string;
    isPrimary?: boolean;
  }) {
    await this.findById(tenantId);

    return adminPrisma.tenantContact.create({
      data: {
        ...data,
        tenantId,
      },
    });
  }

  async enableModule(tenantId: string, moduleId: string) {
    const tenant = await this.findById(tenantId);

    // Verifica se o módulo existe
    const module = await adminPrisma.module.findUnique({
      where: { id: moduleId },
    });

    if (!module) {
      throw new NotFoundException('Módulo não encontrado');
    }

    const tenantModule = await adminPrisma.tenantModule.upsert({
      where: {
        tenantId_moduleId: { tenantId, moduleId },
      },
      update: {
        isEnabled: true,
        disabledAt: null,
      },
      create: {
        tenantId,
        moduleId,
        isEnabled: true,
      },
      include: { module: true },
    });

    // Se o tenant já está provisionado mas o módulo não teve migrations aplicadas
    // retorna um aviso para o usuário
    const needsMigration = tenant.isProvisioned && !tenantModule.migrationsApplied;

    return {
      ...tenantModule,
      warning: needsMigration 
        ? `Módulo habilitado! Como o tenant já está provisionado, execute as migrations do módulo usando POST /migrations/tenant/${tenantId}/module/${moduleId}/apply ou POST /migrations/tenant/${tenantId}/apply-pending`
        : null,
      needsMigration,
    };
  }

  async disableModule(tenantId: string, moduleId: string) {
    return adminPrisma.tenantModule.update({
      where: {
        tenantId_moduleId: { tenantId, moduleId },
      },
      data: {
        isEnabled: false,
        disabledAt: new Date(),
      },
    });
  }

  async setModules(tenantId: string, moduleIds: string[]) {
    const tenant = await this.findById(tenantId);

    // Sempre mantém módulos core
    const coreModules = await adminPrisma.module.findMany({
      where: { isCore: true, isActive: true },
    });
    
    const coreModuleIds = coreModules.map((m: Module) => m.id);
    const allModuleIds = [...new Set([...coreModuleIds, ...moduleIds])];

    // Valida se todos os módulos existem
    const modules = await adminPrisma.module.findMany({
      where: { id: { in: allModuleIds }, isActive: true },
    });

    if (modules.length !== allModuleIds.length) {
      throw new NotFoundException('Um ou mais módulos não foram encontrados');
    }

    // Atualiza módulos em transação
    const result = await adminPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Remove todos os módulos atuais (exceto core que serão re-adicionados)
      await tx.tenantModule.deleteMany({
        where: { tenantId },
      });

      // Adiciona os novos módulos
      await tx.tenantModule.createMany({
        data: allModuleIds.map(moduleId => ({
          tenantId,
          moduleId,
          isEnabled: true,
        })),
      });

      return tx.tenant.findUnique({
        where: { id: tenantId },
        include: {
          modules: { include: { module: true } },
        },
      });
    });

    // Se o tenant já está provisionado, avisa sobre necessidade de migrations
    if (tenant.isProvisioned && result) {
      const modulesWithoutMigration = result.modules.filter(
        (tm: any) => !tm.migrationsApplied
      );

      return {
        ...result,
        warning: modulesWithoutMigration.length > 0
          ? `Módulos atualizados! ${modulesWithoutMigration.length} módulo(s) precisam de migrations. Execute POST /migrations/tenant/${tenantId}/apply-pending`
          : null,
        pendingMigrationsCount: modulesWithoutMigration.length,
      };
    }

    return result;
  }

  async getStatistics() {
    const [total, active, trial, suspended] = await Promise.all([
      adminPrisma.tenant.count(),
      adminPrisma.tenant.count({ where: { status: TenantStatus.ACTIVE } }),
      adminPrisma.tenant.count({ where: { status: TenantStatus.TRIAL } }),
      adminPrisma.tenant.count({ where: { status: TenantStatus.SUSPENDED } }),
    ]);

    return { total, active, trial, suspended };
  }

  async delete(id: string, dropDatabase: boolean = true) {
    const tenant = await this.findById(id);

    const wasProvisioned = tenant.isProvisioned;
    let databaseDropped = false;
    let userDropped = false;
    let dropError: string | null = null;

    // Se estava provisionado e dropDatabase é true, remove o banco e usuário
    if (wasProvisioned && dropDatabase && tenant.databaseName && tenant.databaseUser) {
      try {
        const result = await this.dropTenantDatabase(tenant);
        databaseDropped = result.databaseDropped;
        userDropped = result.userDropped;
      } catch (error: any) {
        dropError = error.message;
        console.error('Erro ao dropar banco:', error);
        // Continua com a exclusão do tenant mesmo se falhar o drop
      }
    }

    // Deleta o registro do tenant
    await adminPrisma.tenant.delete({
      where: { id },
    });

    return { 
      success: true, 
      message: this.buildDeleteMessage(wasProvisioned, databaseDropped, userDropped, dropError, tenant),
      wasProvisioned,
      databaseDropped,
      userDropped,
      databaseName: tenant.databaseName,
      databaseUser: tenant.databaseUser,
      dropError,
    };
  }

  /**
   * Remove o banco de dados e usuário de um tenant do PostgreSQL
   */
  private async dropTenantDatabase(tenant: any): Promise<{ databaseDropped: boolean; userDropped: boolean }> {
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

    let databaseDropped = false;
    let userDropped = false;

    try {
      await client.connect();

      // Desconecta todas as sessões ativas do banco
      await client.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${tenant.databaseName}'
        AND pid <> pg_backend_pid();
      `);

      // Drop do banco de dados
      const dbExists = await client.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [tenant.databaseName],
      );

      if (dbExists.rows.length > 0) {
        await client.query(`DROP DATABASE "${tenant.databaseName}"`);
        console.log(`Database ${tenant.databaseName} dropped successfully`);
        databaseDropped = true;
      }

      // Drop do usuário
      const userExists = await client.query(
        `SELECT 1 FROM pg_roles WHERE rolname = $1`,
        [tenant.databaseUser],
      );

      if (userExists.rows.length > 0) {
        await client.query(`DROP USER "${tenant.databaseUser}"`);
        console.log(`User ${tenant.databaseUser} dropped successfully`);
        userDropped = true;
      }

      return { databaseDropped, userDropped };
    } finally {
      await client.end().catch(() => {});
    }
  }

  private buildDeleteMessage(
    wasProvisioned: boolean, 
    databaseDropped: boolean, 
    userDropped: boolean, 
    dropError: string | null,
    tenant: any
  ): string {
    if (!wasProvisioned) {
      return 'Cliente excluído com sucesso';
    }

    if (dropError) {
      return `Cliente excluído, mas houve erro ao remover o banco: ${dropError}. O banco "${tenant.databaseName}" e usuário "${tenant.databaseUser}" podem precisar ser removidos manualmente.`;
    }

    if (databaseDropped && userDropped) {
      return `Cliente excluído com sucesso. Banco "${tenant.databaseName}" e usuário "${tenant.databaseUser}" foram removidos.`;
    }

    return `Cliente excluído com sucesso.`;
  }
}
