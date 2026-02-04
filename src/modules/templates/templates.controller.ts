import { Controller, Get, Param, Query } from '@nestjs/common';
import { TemplatesService } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  findAll(@Query('all') all?: string) {
    const activeOnly = all !== 'true';
    return this.templatesService.findAll(activeOnly);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.templatesService.findById(id);
  }
}
