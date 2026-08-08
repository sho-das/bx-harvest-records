import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AskController } from './ask/ask.controller';
import { AskService } from './ask/ask.service';
import { LlmService } from './ask/llm';

@Module({
  controllers: [HealthController, AskController],
  providers: [AskService, LlmService],
})
export class AppModule {}
