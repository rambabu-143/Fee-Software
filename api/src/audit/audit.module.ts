import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditInterceptor } from './audit.interceptor.js';

// AppModule also registers { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }.
@Module({ controllers: [AuditController], providers: [AuditInterceptor], exports: [AuditInterceptor] })
export class AuditModule {}
