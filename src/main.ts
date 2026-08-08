import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // No global ValidationPipe. Request bodies are validated with zod, the same
  // library that validates the model's output, so there is one validator here.
  const app = await NestFactory.create(AppModule);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  console.log(`Listening on http://localhost:${port}`);
  console.log(`  GET  /health`);
  console.log(`  POST /ask   body: {"question": "..."}`);
}

bootstrap();
