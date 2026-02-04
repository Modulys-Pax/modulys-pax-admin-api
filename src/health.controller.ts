import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './modules/auth/public.decorator';

@Controller('health')
@SkipThrottle()
export class HealthController {
  @Public()
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'modulys-pax-admin-api',
      timestamp: new Date().toISOString(),
    };
  }
}
