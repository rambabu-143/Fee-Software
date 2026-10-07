import { Module } from '@nestjs/common';
import { VouchersController } from './vouchers.controller.js';

@Module({ controllers: [VouchersController] })
export class VouchersModule {}
