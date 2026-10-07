import { Module } from '@nestjs/common';
import { BillingService } from '../billing/billing.service.js';
import { DocumentsController } from './documents.controller.js';

@Module({ controllers: [DocumentsController], providers: [BillingService] })
export class DocumentsModule {}
