import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { closePool } from './db/pool';

async function bootstrap() {
  // No global ValidationPipe. Request bodies are validated with zod, the same
  // library that validates the model's output, so there is one validator here.
  const app = await NestFactory.create(AppModule);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  console.log(`Listening on http://localhost:${port}`);
  console.log(`  GET  /health`);
  console.log(`  POST /ask   body: {"question": "..."}`);

  /**
   * Shut down in this order, and only this order.
   *
   * `app.close()` first: it stops accepting new connections and waits for the
   * requests already running. Ending the pool first would pull the connection
   * out from under a query that is mid-flight, and the customer waiting on it
   * would get a driver error instead of their answer.
   *
   * Then the pool. Postgres holds an idle connection open until something ends
   * it, so leaving without this leaves a session behind on every restart.
   */
  let closing = false;
  const shutdown = async (signal: string) => {
    // Ctrl-C twice sends SIGINT twice. Without this the second one starts a
    // second close while the first is still waiting on in-flight requests.
    if (closing) return;
    closing = true;

    console.log(`\n${signal} received. Finishing in-flight requests.`);
    try {
      await app.close();
      await closePool();
      console.log('Closed the server and the database pool.');
      process.exit(0);
    } catch (error) {
      console.error('Shutdown failed:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap();
