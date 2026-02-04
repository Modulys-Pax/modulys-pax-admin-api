import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TenantAuthService } from './tenant-auth.service';
import { TenantAuthController } from './tenant-auth.controller';
import { TenantModule } from '../tenant/tenant.module';
import { ProvisioningModule } from '../provisioning/provisioning.module';

@Module({
  imports: [
    TenantModule,
    ProvisioningModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_TENANT_EXPIRATION', '8h'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [TenantAuthController],
  providers: [TenantAuthService],
  exports: [TenantAuthService],
})
export class TenantAuthModule {}
