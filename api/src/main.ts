import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
// The placeholder ships in .env.example; anyone who knows it can forge a SUPERADMIN token.
if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.startsWith('change-me')) throw new Error('JWT_SECRET is still the placeholder');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Express's 100kb default would reject a 2000-row student import long before the row cap does.
  app.useBodyParser('json', { limit: '2mb' });
  app.disable('x-powered-by');
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  // ponytail: docs open to anyone; gate or disable in prod if the API is public
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app,
    new DocumentBuilder().setTitle('Fees API').addBearerAuth().build()));
  await app.listen(process.env.PORT ?? 3100);
}
await bootstrap();
