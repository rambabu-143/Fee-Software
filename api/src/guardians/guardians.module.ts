import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { GuardiansController } from './guardians.controller.js';

@Module({ controllers: [GuardiansController, CatalogController] })
export class GuardiansModule {}
