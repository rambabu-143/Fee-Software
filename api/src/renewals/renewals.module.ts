import { Module } from '@nestjs/common';
import { RenewalsController } from './renewals.controller.js';

@Module({ controllers: [RenewalsController] })
export class RenewalsModule {}
