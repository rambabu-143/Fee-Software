import { Module } from '@nestjs/common';
import { BanksController } from './banks.controller.js';

@Module({ controllers: [BanksController] })
export class BanksModule {}
