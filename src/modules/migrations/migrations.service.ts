import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { adminPrisma } from '@modulys-pax/admin-database';
import { TenantService } from '../tenant/tenant.service';
import { Client } from 'pg';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class MigrationsService {
  private readonly databaseProjectPath: string;
  private readonly workspaceRoot: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly tenantService: TenantService,
  ) {
    // Diretório base para resolver caminhos relativos (raiz do modulys-pax-admin-api)
    const baseDir = path.resolve(__dirname, '../../../');

    // Caminho do projeto modulys-pax-database (onde está o schema Prisma padrão)
    const dbPath = this.configService.get('DATABASE_PROJECT_PATH', '../modulys-pax-database');
    this.databaseProjectPath = path.resolve(baseDir, dbPath);

    // Raiz do workspace (onde ficam todos os projetos: modulys-pax-*, etc.)
    const wsPath = this.configService.get('WORKSPACE_ROOT', '../');
    this.workspaceRoot = path.resolve(baseDir, wsPath);

    console.log(`[MigrationsService] Workspace root: ${this.workspaceRoot}`);
    console.log(`[MigrationsService] Database project: ${this.databaseProjectPath}`);
  }

  /**
   * Aplica migrations Prisma para um tenant
   * 1. Primeiro aplica migrations padrão do modulys-pax-database
   * 2. Depois aplica migrations de cada módulo customizado
   */
  async applyMigrations(tenantId: string) {
    const tenant = await this.tenantService.findById(tenantId);

    if (!tenant.isProvisioned) {
      throw new BadRequestException('Tenant ainda não foi provisionado. Provisione o banco primeiro.');
    }

    // Monta a connection string do tenant
    const connectionString = this.buildConnectionString(tenant);
    const results: { module: string; type: 'standard' | 'custom'; success: boolean; message: string }[] = [];

    try {
      console.log(`Aplicando migrations para tenant: ${tenant.code}`);
      console.log(`Database: ${tenant.databaseName}`);

      // 1. Aplica migrations padrão do modulys-pax-database
      console.log('\n=== Aplicando migrations padrão ===');
      const standardResult = await this.runPrismaMigrate(this.databaseProjectPath, connectionString);
      results.push({
        module: 'core',
        type: 'standard',
        success: true,
        message: standardResult,
      });

      // 2. Aplica migrations de módulos padrão com SQL opcional (ex: internal_chat)
      const standardModules = tenant.modules.filter(
        (tm: any) => tm.isEnabled && !tm.module.isCustom,
      );

      for (const tm of standardModules) {
        const module = tm.module;
        const migrationsDir = this.getStandardModuleMigrationsDir(module.code);

        if (migrationsDir && fs.existsSync(migrationsDir)) {
          const sqlFiles = fs.readdirSync(migrationsDir)
            .filter((f) => f.endsWith('.sql'))
            .sort();

          if (sqlFiles.length > 0) {
            console.log(`\n=== Aplicando migrations SQL do módulo padrão: ${module.name} (${module.code}) ===`);
            try {
              const sqlResult = await this.runStandardModuleSqlMigrations(connectionString, module.code);
              results.push({
                module: module.code,
                type: 'standard',
                success: true,
                message: sqlResult,
              });
              await adminPrisma.tenantModule.update({
                where: { id: tm.id },
                data: {
                  migrationsApplied: true,
                  migrationsAppliedAt: new Date(),
                  schemaVersion: module.version,
                },
              });
            } catch (error: any) {
              console.error(`Erro no módulo ${module.code}:`, error.message);
              results.push({
                module: module.code,
                type: 'standard',
                success: false,
                message: error.message,
              });
            }
          } else {
            await adminPrisma.tenantModule.update({
              where: { id: tm.id },
              data: {
                migrationsApplied: true,
                migrationsAppliedAt: new Date(),
                schemaVersion: module.version,
              },
            });
          }
        } else {
          // Módulo padrão sem migrations SQL opcionais (ex: core) — já coberto pelo Prisma migrate acima
          await adminPrisma.tenantModule.update({
            where: { id: tm.id },
            data: {
              migrationsApplied: true,
              migrationsAppliedAt: new Date(),
              schemaVersion: tm.module.version,
            },
          });
        }
      }

      // 3. Aplica migrations de módulos customizados
      const customModules = tenant.modules.filter(
        (tm: any) => tm.isEnabled && tm.module.isCustom && tm.module.modulePath,
      );

      for (const tm of customModules) {
        const module = tm.module;
        console.log(`\n=== Aplicando migrations do módulo customizado: ${module.name} ===`);
        
        try {
          const modulePath = this.resolveModulePath(module);
          const migrationsPath = module.migrationsPath || 'prisma';
          const fullMigrationsPath = path.join(modulePath, migrationsPath);

          const schemaPath = path.join(fullMigrationsPath, 'schema.prisma');
          if (!fs.existsSync(schemaPath)) {
            console.log(`Schema não encontrado em ${schemaPath}, pulando módulo...`);
            results.push({
              module: module.code,
              type: 'custom',
              success: false,
              message: `Schema Prisma não encontrado em ${migrationsPath}/schema.prisma`,
            });
            continue;
          }

          const customResult = await this.runPrismaMigrate(fullMigrationsPath, connectionString);
          results.push({
            module: module.code,
            type: 'custom',
            success: true,
            message: customResult,
          });

          await adminPrisma.tenantModule.update({
            where: { id: tm.id },
            data: {
              migrationsApplied: true,
              migrationsAppliedAt: new Date(),
              schemaVersion: module.version,
            },
          });

        } catch (error: any) {
          console.error(`Erro no módulo ${module.code}:`, error.message);
          results.push({
            module: module.code,
            type: 'custom',
            success: false,
            message: error.message,
          });
        }
      }

      // Monta mensagem de resumo
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      return {
        success: failCount === 0,
        message: `Migrations aplicadas: ${successCount} sucesso, ${failCount} falhas`,
        results,
      };

    } catch (error: any) {
      console.error('Erro ao aplicar migrations:', error);
      
      const errorMessage = error.stderr || error.stdout || error.message || 'Erro desconhecido';
      throw new BadRequestException(`Erro ao aplicar migrations: ${errorMessage}`);
    }
  }

  /**
   * Executa prisma migrate deploy em um diretório específico
   */
  private runPrismaMigrate(cwd: string, connectionString: string): string {
    console.log(`Executando prisma migrate deploy em: ${cwd}`);
    
    const result = execSync(
      `npx prisma migrate deploy`,
      {
        cwd,
        env: {
          ...process.env,
          DATABASE_URL: connectionString,
        },
        encoding: 'utf-8',
        timeout: 120000, // 2 minutos para módulos maiores
      },
    );

    console.log('Resultado:', result);
    return result;
  }

  /**
   * Caminho das migrations SQL opcionais para módulos padrão (ex: internal_chat).
   * Convenção: modulys-pax-database/prisma/module-migrations/<moduleCode>/
   */
  private getStandardModuleMigrationsDir(moduleCode: string): string {
    return path.join(this.databaseProjectPath, 'prisma', 'module-migrations', moduleCode);
  }

  /**
   * Executa os arquivos .sql do módulo padrão no banco do tenant.
   * Usado quando o módulo está habilitado para o tenant (ex: internal_chat).
   */
  private async runStandardModuleSqlMigrations(
    connectionString: string,
    moduleCode: string,
  ): Promise<string> {
    const migrationsDir = this.getStandardModuleMigrationsDir(moduleCode);
    if (!fs.existsSync(migrationsDir)) {
      return 'Nenhum diretório de migrations encontrado';
    }

    const sqlFiles = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (sqlFiles.length === 0) {
      return 'Nenhum arquivo .sql encontrado';
    }

    const client = new Client({ connectionString });
    await client.connect();

    try {
      const executed: string[] = [];
      for (const file of sqlFiles) {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');
        await client.query(sql);
        executed.push(file);
        console.log(`Executado: ${file}`);
      }
      return `Arquivos aplicados: ${executed.join(', ')}`;
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Resolve o caminho do módulo customizado
   * modulePath é apenas o nome da pasta do projeto (ex: "modulys-pax-baileys-service")
   * O sistema concatena com o workspaceRoot automaticamente
   */
  private resolveModulePath(module: any): string {
    const modulePath = module.modulePath;
    
    if (!modulePath) {
      throw new Error(`Módulo ${module.code} não tem modulePath configurado`);
    }

    // Concatena: workspaceRoot + nome da pasta
    const resolvedPath = path.join(this.workspaceRoot, modulePath);
    
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Pasta do módulo não encontrada: ${resolvedPath}. Verifique se o nome da pasta está correto.`);
    }
    
    console.log(`Usando módulo em: ${resolvedPath}`);
    return resolvedPath;
  }

  /**
   * Gera o Prisma Client para o banco do tenant (útil para desenvolvimento)
   */
  async generateClient(tenantId: string) {
    const tenant = await this.tenantService.findById(tenantId);

    if (!tenant.isProvisioned) {
      throw new BadRequestException('Tenant ainda não foi provisionado.');
    }

    const connectionString = this.buildConnectionString(tenant);

    try {
      const result = execSync(
        `npx prisma generate`,
        {
          cwd: this.databaseProjectPath,
          env: {
            ...process.env,
            DATABASE_URL: connectionString,
          },
          encoding: 'utf-8',
        },
      );

      return { success: true, output: result };
    } catch (error: any) {
      throw new BadRequestException(`Erro ao gerar client: ${error.message}`);
    }
  }

  /**
   * Verifica status das migrations de um tenant
   */
  async getMigrationsStatus(tenantId: string) {
    const tenant = await this.tenantService.findById(tenantId);

    if (!tenant.isProvisioned) {
      return { 
        provisioned: false, 
        migrationsApplied: false,
        modules: [] 
      };
    }

    // Verifica se algum módulo já teve migrations aplicadas
    const hasAppliedMigrations = tenant.modules.some((tm: any) => tm.migrationsApplied);

    // Mapeia status por módulo
    const modulesStatus = tenant.modules.map((tm: any) => ({
      moduleId: tm.moduleId,
      moduleCode: tm.module.code,
      moduleName: tm.module.name,
      isCustom: tm.module.isCustom,
      isEnabled: tm.isEnabled,
      migrationsApplied: tm.migrationsApplied,
      migrationsAppliedAt: tm.migrationsAppliedAt,
      schemaVersion: tm.schemaVersion,
      needsMigration: tm.isEnabled && !tm.migrationsApplied, // Novo campo!
    }));

    // Conta módulos que precisam de migration
    const pendingMigrations = modulesStatus.filter((m: any) => m.needsMigration);

    return {
      provisioned: true,
      migrationsApplied: hasAppliedMigrations,
      pendingMigrationsCount: pendingMigrations.length,
      modules: modulesStatus,
    };
  }

  /**
   * Aplica migrations de um módulo específico para um tenant
   * Útil quando um novo módulo é adicionado a um tenant já provisionado
   */
  async applyModuleMigrations(tenantId: string, moduleId: string) {
    const tenant = await this.tenantService.findById(tenantId);

    if (!tenant.isProvisioned) {
      throw new BadRequestException('Tenant ainda não foi provisionado. Provisione o banco primeiro.');
    }

    // Busca o TenantModule específico
    const tenantModule = tenant.modules.find((tm: any) => tm.moduleId === moduleId);
    
    if (!tenantModule) {
      throw new NotFoundException('Módulo não está associado a este tenant. Habilite o módulo primeiro.');
    }

    if (!tenantModule.isEnabled) {
      throw new BadRequestException('Módulo está desabilitado. Habilite o módulo primeiro.');
    }

    const module = tenantModule.module;
    const connectionString = this.buildConnectionString(tenant);

    console.log(`Aplicando migrations do módulo ${module.code} para tenant ${tenant.code}`);

    try {
      if (module.isCustom) {
        // Módulo customizado - usa caminho local
        if (!module.modulePath) {
          throw new BadRequestException('Módulo customizado não tem modulePath configurado.');
        }

        const modulePath = this.resolveModulePath(module);
        const migrationsPath = module.migrationsPath || 'prisma';
        const fullMigrationsPath = path.join(modulePath, migrationsPath);

        const schemaPath = path.join(fullMigrationsPath, 'schema.prisma');
        if (!fs.existsSync(schemaPath)) {
          throw new BadRequestException(`Schema Prisma não encontrado em ${migrationsPath}/schema.prisma`);
        }

        const result = await this.runPrismaMigrate(fullMigrationsPath, connectionString);

        // Atualiza status
        await adminPrisma.tenantModule.update({
          where: { id: tenantModule.id },
          data: {
            migrationsApplied: true,
            migrationsAppliedAt: new Date(),
            schemaVersion: module.version,
          },
        });

        return {
          success: true,
          module: module.code,
          type: 'custom',
          message: result,
        };
      } else {
        // Módulo padrão: pode ter migrations SQL opcionais (ex: internal_chat) ou só core
        const migrationsDir = this.getStandardModuleMigrationsDir(module.code);

        if (migrationsDir && fs.existsSync(migrationsDir)) {
          const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
          if (sqlFiles.length > 0) {
            const result = await this.runStandardModuleSqlMigrations(connectionString, module.code);
            await adminPrisma.tenantModule.update({
              where: { id: tenantModule.id },
              data: {
                migrationsApplied: true,
                migrationsAppliedAt: new Date(),
                schemaVersion: module.version,
              },
            });
            return {
              success: true,
              module: module.code,
              type: 'standard',
              message: result,
            };
          }
        }

        // Módulo padrão sem SQL opcional — aplica migrations core (Prisma)
        const result = await this.runPrismaMigrate(this.databaseProjectPath, connectionString);
        await adminPrisma.tenantModule.update({
          where: { id: tenantModule.id },
          data: {
            migrationsApplied: true,
            migrationsAppliedAt: new Date(),
            schemaVersion: module.version,
          },
        });
        return {
          success: true,
          module: module.code,
          type: 'standard',
          message: result,
        };
      }
    } catch (error: any) {
      console.error(`Erro ao aplicar migrations do módulo ${module.code}:`, error);
      throw new BadRequestException(`Erro ao aplicar migrations: ${error.message}`);
    }
  }

  /**
   * Aplica migrations apenas dos módulos que ainda não foram migrados
   * Útil para atualizar um tenant existente com novos módulos
   */
  async applyPendingMigrations(tenantId: string) {
    const tenant = await this.tenantService.findById(tenantId);

    if (!tenant.isProvisioned) {
      throw new BadRequestException('Tenant ainda não foi provisionado. Provisione o banco primeiro.');
    }

    const connectionString = this.buildConnectionString(tenant);
    const results: { module: string; type: string; success: boolean; message: string }[] = [];

    // Filtra módulos que precisam de migration
    const pendingModules = tenant.modules.filter(
      (tm: any) => tm.isEnabled && !tm.migrationsApplied
    );

    if (pendingModules.length === 0) {
      return {
        success: true,
        message: 'Nenhuma migration pendente',
        results: [],
      };
    }

    console.log(`Aplicando ${pendingModules.length} migrations pendentes para tenant ${tenant.code}`);

    // Primeiro aplica módulos padrão pendentes (core = Prisma; outros com SQL opcional = run SQL)
    const standardPending = pendingModules.filter((tm: any) => !tm.module.isCustom);
    const standardWithSql = standardPending.filter(
      (tm: any) => this.getStandardModuleMigrationsDir(tm.module.code) && fs.existsSync(this.getStandardModuleMigrationsDir(tm.module.code)),
    );
    const standardWithoutSql = standardPending.filter(
      (tm: any) => !standardWithSql.includes(tm),
    );

    if (standardWithoutSql.length > 0) {
      try {
        console.log('Aplicando migrations padrão (core)...');
        await this.runPrismaMigrate(this.databaseProjectPath, connectionString);
        for (const tm of standardWithoutSql) {
          await adminPrisma.tenantModule.update({
            where: { id: tm.id },
            data: {
              migrationsApplied: true,
              migrationsAppliedAt: new Date(),
              schemaVersion: tm.module.version,
            },
          });
          results.push({ module: tm.module.code, type: 'standard', success: true, message: 'Migrations aplicadas' });
        }
      } catch (error: any) {
        for (const tm of standardWithoutSql) {
          results.push({ module: tm.module.code, type: 'standard', success: false, message: error.message });
        }
      }
    }

    for (const tm of standardWithSql) {
      const module = tm.module;
      const migrationsDir = this.getStandardModuleMigrationsDir(module.code);
      if (!migrationsDir || !fs.existsSync(migrationsDir)) continue;
      const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
      if (sqlFiles.length === 0) continue;
      try {
        console.log(`Aplicando migrations SQL do módulo: ${module.code}`);
        const msg = await this.runStandardModuleSqlMigrations(connectionString, module.code);
        await adminPrisma.tenantModule.update({
          where: { id: tm.id },
          data: {
            migrationsApplied: true,
            migrationsAppliedAt: new Date(),
            schemaVersion: module.version,
          },
        });
        results.push({ module: module.code, type: 'standard', success: true, message: msg });
      } catch (error: any) {
        results.push({ module: module.code, type: 'standard', success: false, message: error.message });
      }
    }

    // Depois aplica módulos customizados
    const customModules = pendingModules.filter(
      (tm: any) => tm.module.isCustom && tm.module.modulePath
    );

    for (const tm of customModules) {
      const module = tm.module;
      try {
        console.log(`Aplicando migrations do módulo customizado: ${module.code}`);
        
        const modulePath = this.resolveModulePath(module);
        const migrationsPath = module.migrationsPath || 'prisma';
        const fullMigrationsPath = path.join(modulePath, migrationsPath);

        const schemaPath = path.join(fullMigrationsPath, 'schema.prisma');
        if (!fs.existsSync(schemaPath)) {
          results.push({
            module: module.code,
            type: 'custom',
            success: false,
            message: `Schema não encontrado em ${migrationsPath}/schema.prisma`,
          });
          continue;
        }

        const result = await this.runPrismaMigrate(fullMigrationsPath, connectionString);

        await adminPrisma.tenantModule.update({
          where: { id: tm.id },
          data: {
            migrationsApplied: true,
            migrationsAppliedAt: new Date(),
            schemaVersion: module.version,
          },
        });

        results.push({
          module: module.code,
          type: 'custom',
          success: true,
          message: result,
        });
      } catch (error: any) {
        results.push({
          module: module.code,
          type: 'custom',
          success: false,
          message: error.message,
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return {
      success: failCount === 0,
      message: `Migrations pendentes aplicadas: ${successCount} sucesso, ${failCount} falhas`,
      results,
    };
  }

  /**
   * Monta a connection string para o banco do tenant
   */
  private buildConnectionString(tenant: any): string {
    const password = this.decrypt(tenant.databasePass);
    // Escapa caracteres especiais na senha para uso em URL
    const encodedPassword = encodeURIComponent(password);
    const port = Number(tenant.databasePort) || 5432;
    return `postgresql://${tenant.databaseUser}:${encodedPassword}@${tenant.databaseHost}:${port}/${tenant.databaseName}?schema=public`;
  }

  // Decrypt helper
  private decrypt(encrypted: string): string {
    return Buffer.from(encrypted, 'base64').toString('utf-8');
  }
}
