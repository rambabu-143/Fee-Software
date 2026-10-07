import { Module } from '@nestjs/common';
import { BillingService } from '../billing/billing.service.js';
import { SmsController } from './sms.controller.js';

@Module({ controllers: [SmsController], providers: [BillingService] })
export class SmsModule {}
