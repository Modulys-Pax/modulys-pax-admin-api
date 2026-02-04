import { Injectable, NotFoundException } from '@nestjs/common';
import { adminPrisma } from '@modulys-pax/admin-database';

@Injectable()
export class TemplatesService {
  async findAll(activeOnly = true) {
    return adminPrisma.template.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string) {
    const template = await adminPrisma.template.findUnique({
      where: { id },
    });
    if (!template) {
      throw new NotFoundException('Template não encontrado');
    }
    return template;
  }

  async findByCode(code: string) {
    const template = await adminPrisma.template.findUnique({
      where: { code },
    });
    if (!template) {
      throw new NotFoundException('Template não encontrado');
    }
    return template;
  }
}
