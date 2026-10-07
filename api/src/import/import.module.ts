import { Module } from '@nestjs/common';
import { ImportController } from './import.controller.js';

@Module({ controllers: [ImportController] })
export class ImportModule {}
