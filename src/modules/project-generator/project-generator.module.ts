import { Module } from '@nestjs/common';
import { ProjectGeneratorService } from './project-generator.service';
import { ProjectGeneratorController } from './project-generator.controller';
import { TenantModule } from '../tenant/tenant.module';
import { TemplatesModule } from '../templates/templates.module';

@Module({
  imports: [TenantModule, TemplatesModule],
  controllers: [ProjectGeneratorController],
  providers: [ProjectGeneratorService],
})
export class ProjectGeneratorModule {}
