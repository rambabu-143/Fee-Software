import { Module } from '@nestjs/common';
import { BillingService } from '../billing/billing.service.js';
import { DefaultersController, DefaulterTemplatesController } from './defaulters.controller.js';
import { DefaultersService } from './defaulters.service.js';

@Module({
  controllers: [DefaultersController, DefaulterTemplatesController],
  providers: [DefaultersService, BillingService],
})
export class DefaultersModule {}
