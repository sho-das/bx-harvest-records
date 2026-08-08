import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AskController } from './ask/ask.controller';
import { AskService } from './ask/ask.service';
import { LlmService } from './ask/llm';
import { UiController } from './ui/ui.controller';

@Module({
  controllers: [HealthController, AskController, UiController],
  providers: [AskService, LlmService],
})
export class AppModule {}
