import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ProjectGeneratorService } from './project-generator.service';

@Controller('project-generator')
export class ProjectGeneratorController {
  constructor(private readonly projectGeneratorService: ProjectGeneratorService) {}

  @Get('generate')
  async generate(
    @Query('tenantId') tenantId: string,
    @Query('templateId') templateId: string,
  ): Promise<StreamableFile> {
    const { stream, filename } = await this.projectGeneratorService.generateZip(tenantId, templateId);
    return new StreamableFile(stream, {
      type: 'application/zip',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
