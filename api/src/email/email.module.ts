import { Module } from '@nestjs/common';
import { BillingService } from '../billing/billing.service.js';
import { EmailController } from './email.controller.js';

@Module({ controllers: [EmailController], providers: [BillingService] })
export class EmailModule {}
