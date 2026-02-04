import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './modules/auth/auth.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { PlanModule } from './modules/plan/plan.module';
import { ModuleModule } from './modules/module/module.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { ProvisioningModule } from './modules/provisioning/provisioning.module';
import { MigrationsModule } from './modules/migrations/migrations.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { ProjectGeneratorModule } from './modules/project-generator/project-generator.module';
import { TenantAuthModule } from './modules/tenant-auth/tenant-auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    AuthModule,
    TenantModule,
    PlanModule,
    ModuleModule,
    SubscriptionModule,
    ProvisioningModule,
    MigrationsModule,
    WhatsAppModule,
    TemplatesModule,
    ProjectGeneratorModule,
    TenantAuthModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
