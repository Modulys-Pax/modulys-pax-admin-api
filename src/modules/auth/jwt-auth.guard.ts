import { Injectable, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private configService: ConfigService,
  ) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Verifica Service Key para comunicação entre serviços
    const request = context.switchToHttp().getRequest();
    const serviceKey = request.headers['x-service-key'];
    const validServiceKey = this.configService.get<string>('PAX_SERVICE_KEY');

    if (serviceKey && validServiceKey && serviceKey === validServiceKey) {
      // Adiciona um usuário fictício para requests de serviço
      request.user = { id: 'service', email: 'service@internal', isService: true };
      return true;
    }

    return super.canActivate(context);
  }
}
