import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { adminPrisma } from '@modulys-pax/admin-database';

@Injectable()
export class ModuleService {
  async create(data: {
    code: string;
    name: string;
    description?: string;
    version?: string;
    isCore?: boolean;
    isCustom?: boolean;
    repositoryUrl?: string;  // Link do GitHub (referência)
    modulePath?: string;     // Nome da pasta do projeto (ex: modulys-pax-baileys-service)
    migrationsPath?: string; // Subpasta das migrations (padrão: prisma)
  }) {
    // Verifica se já existe módulo com mesmo código
    const existing = await adminPrisma.module.findUnique({
      where: { code: data.code },
    });

    if (existing) {
      throw new ConflictException('Já existe um módulo com este código');
    }

    // Módulos customizados DEVEM ter modulePath
    if (data.isCustom && !data.modulePath) {
      throw new BadRequestException(
        'Módulos customizados devem ter o campo "modulePath" preenchido com o nome da pasta do projeto (ex: modulys-pax-baileys-service)'
      );
    }

    return adminPrisma.module.create({ data });
  }

  async findAll(filters?: { isCustom?: boolean }) {
    return adminPrisma.module.findMany({
      where: {
        ...(filters?.isCustom !== undefined && { isCustom: filters.isCustom }),
      },
      include: {
        _count: {
          select: {
            plans: true,
            tenants: { where: { isEnabled: true } },
          },
        },
      },
      orderBy: [{ isCore: 'desc' }, { isCustom: 'asc' }, { name: 'asc' }],
    });
  }

  async findById(id: string) {
    const module = await adminPrisma.module.findUnique({
      where: { id },
      include: {
        plans: { include: { plan: true } },
        tenants: {
          where: { isEnabled: true },
          include: { tenant: true },
        },
      },
    });

    if (!module) {
      throw new NotFoundException('Módulo não encontrado');
    }

    return module;
  }

  async update(id: string, data: Partial<{
    name: string;
    description: string;
    version: string;
    isActive: boolean;
    isCustom: boolean;
    repositoryUrl: string;  // Link do GitHub (referência)
    modulePath: string;     // Nome da pasta do projeto (ex: modulys-pax-baileys-service)
    migrationsPath: string; // Subpasta das migrations (padrão: prisma)
  }>) {
    const module = await this.findById(id) as any;

    // Se está tornando customizado, deve ter modulePath
    const willBeCustom = data.isCustom ?? module.isCustom;
    const finalModulePath = data.modulePath ?? module.modulePath;

    if (willBeCustom && !finalModulePath) {
      throw new BadRequestException(
        'Módulos customizados devem ter o campo "modulePath" preenchido com o nome da pasta do projeto (ex: modulys-pax-baileys-service)'
      );
    }

    return adminPrisma.module.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    const module = await this.findById(id);

    // Não permite deletar módulos core
    if (module.isCore) {
      throw new BadRequestException('Não é possível excluir módulos core do sistema');
    }

    // Não permite deletar se estiver em uso
    const tenantsCount = await adminPrisma.tenantModule.count({
      where: { moduleId: id, isEnabled: true },
    });

    if (tenantsCount > 0) {
      throw new BadRequestException(`Este módulo está em uso por ${tenantsCount} cliente(s). Desabilite o módulo dos clientes antes de excluir.`);
    }

    await adminPrisma.module.delete({ where: { id } });

    return { success: true, message: 'Módulo excluído com sucesso' };
  }

  async seed() {
    // Módulos do sistema: core (obrigatório) e padrão (opcional, ex: internal_chat)
    const modules = [
      {
        code: 'core',
        name: 'Core',
        description: 'Autenticação, usuários, empresa, filiais, permissões',
        isCore: true,
        isCustom: false,
      },
      {
        code: 'internal_chat',
        name: 'Chat interno',
        description: 'Chat interno entre colaboradores (canais e mensagens)',
        isCore: false,
        isCustom: false,
      },
    ];

    for (const module of modules) {
      await adminPrisma.module.upsert({
        where: { code: module.code },
        update: module,
        create: module,
      });
    }

    // Remove módulos fictícios antigos se existirem (não remove internal_chat)
    await adminPrisma.module.deleteMany({
      where: {
        code: { in: ['hr', 'fleet', 'stock', 'financial', 'chat'] },
        tenants: { none: { isEnabled: true } },
      },
    });

    return adminPrisma.module.findMany();
  }
}
