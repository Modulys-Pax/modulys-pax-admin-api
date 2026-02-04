import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

function validateRequiredEnv(configService: ConfigService): void {
  const jwtSecret = configService.get<string>('PAX_JWT_SECRET')?.trim();
  const serviceKey = configService.get<string>('PAX_SERVICE_KEY')?.trim();
  if (!jwtSecret) throw new Error('PAX_JWT_SECRET is required. Set it in .env.');
  if (!serviceKey) throw new Error('PAX_SERVICE_KEY is required. Set it in .env.');
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  validateRequiredEnv(configService);

  app.use(helmet());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const isProduction = configService.get<string>('NODE_ENV') === 'production';
  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  app.enableCors({
    origin: isProduction && corsOrigin
      ? corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
      : true,
    credentials: true,
  });

  app.setGlobalPrefix('api/admin');

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                 Modulys Pax ADMIN BACKOFFICE                    ║
╠══════════════════════════════════════════════════════════════╣
║  🔐 Admin API running on: http://localhost:${port}/api/admin     ║
║  📊 Tenant Management                                        ║
║  💳 Subscription & Billing                                   ║
║  🔧 Module Provisioning                                      ║
╚══════════════════════════════════════════════════════════════╝
  `);
}

bootstrap();
