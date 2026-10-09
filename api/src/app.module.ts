import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from './prisma/prisma.service.js';
import { PrismaErrorFilter } from './prisma/prisma-error.filter.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { SchoolsController } from './schools/schools.controller.js';
import { YearsController } from './masters/years.controller.js';
import { StandardsController } from './masters/standards.controller.js';
import { FeeHeadsController } from './masters/fee-heads.controller.js';
import { InstallmentsController } from './masters/installments.controller.js';
import { FeeStructureController } from './masters/fee-structure.controller.js';
import { FacilitiesController } from './masters/facilities.controller.js';
import { StudentsController } from './students/students.controller.js';
import { PaymentsController } from './billing/payments.controller.js';
import { ConcessionsController } from './students/concessions.controller.js';
import { StopsController } from './masters/stops.controller.js';
import { StudentTransportController } from './students/student-transport.controller.js';
import { WithdrawalsController } from './students/withdrawals.controller.js';
import { FinesController } from './students/fines.controller.js';
import { StudentFacilitiesController } from './students/facilities.controller.js';
import { PromotionsController } from './students/promotions.controller.js';
import { ReportsController } from './reports/reports.controller.js';
import { UsersController } from './auth/users.controller.js';
import { BillingService } from './billing/billing.service.js';
import { ArrearsModule } from './arrears/arrears.module.js';
import { DepositsModule } from './deposits/deposits.module.js';
import { VouchersModule } from './vouchers/vouchers.module.js';
import { BanksModule } from './banks/banks.module.js';
import { RenewalsModule } from './renewals/renewals.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { GuardiansModule } from './guardians/guardians.module.js';
import { ReportsExtraModule } from './reports-extra/reports-extra.module.js';
import { SmsModule } from './sms/sms.module.js';
import { EmailModule } from './email/email.module.js';
import { ImportModule } from './import/import.module.js';
import { AuditModule } from './audit/audit.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { DefaultersModule } from './defaulters/defaulters.module.js';
import { AuditInterceptor } from './audit/audit.interceptor.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    ArrearsModule,
    DepositsModule,
    VouchersModule,
    BanksModule,
    RenewalsModule,
    DocumentsModule,
    GuardiansModule,
    ReportsExtraModule,
    SmsModule,
    EmailModule,
    ImportModule,
    AuditModule,
    SettingsModule,
    DefaultersModule,
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [
    AuthController,
    SchoolsController,
    YearsController,
    StandardsController,
    FeeHeadsController,
    InstallmentsController,
    FeeStructureController,
    FacilitiesController,
    StudentsController,
    PaymentsController,
    ConcessionsController,
    FinesController,
    WithdrawalsController,
    StopsController,
    StudentTransportController,
    StudentFacilitiesController,
    PromotionsController,
    ReportsController,
    UsersController,
  ],
  providers: [
    BillingService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: PrismaErrorFilter },
  ],
})
export class AppModule {}
