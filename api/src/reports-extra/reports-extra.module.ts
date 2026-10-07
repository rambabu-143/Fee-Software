import { Module } from '@nestjs/common';
import { BillingService } from '../billing/billing.service.js';
import { MoneyReportsController } from './money.controller.js';
import { PeopleReportsController } from './people.controller.js';

@Module({ controllers: [PeopleReportsController, MoneyReportsController], providers: [BillingService] })
export class ReportsExtraModule {}
