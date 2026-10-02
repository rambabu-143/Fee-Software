import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
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

@Module({
  imports: [
    PrismaModule,
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
    { provide: APP_FILTER, useClass: PrismaErrorFilter },
  ],
})
export class AppModule {}
