import { Module } from '@nestjs/common';
import { BillingService } from '../billing/billing.service.js';
import { ArrearsController } from './arrears.controller.js';

@Module({ controllers: [ArrearsController], providers: [BillingService] })
export class ArrearsModule {}
