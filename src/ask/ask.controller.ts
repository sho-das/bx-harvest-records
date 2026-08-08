import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { AskService } from './ask.service';
import { IntentRejected } from './intent.schema';
import { LlmFailed } from './llm';

const AskBody = z.object({
  question: z.string().trim().min(1, 'must not be empty').max(500, 'must be under 500 characters'),
});

/**
 * The one endpoint.
 *
 * POST, not GET with a query parameter. A question written in English needs
 * URL encoding, and a URL is written to the access log of every proxy it
 * passes through. A body is not.
 */
@Controller('ask')
export class AskController {
  constructor(private readonly ask: AskService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async post(@Body() body: unknown) {
    const parsed = AskBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        answered: false,
        answer_kg: null,
        reason: `The request body needs a "question" field: ${parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')}`,
      });
    }

    try {
      return await this.ask.ask(parsed.data.question);
    } catch (error) {
      // Every failure below returns answer_kg: null and nothing that could be
      // read as a weight. A refusal that carries a number is a wrong number.
      if (error instanceof IntentRejected) {
        throw new HttpException(
          {
            answered: false,
            answer_kg: null,
            reason: error.reason,
            question: parsed.data.question,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      if (error instanceof LlmFailed) {
        throw new HttpException(
          {
            answered: false,
            answer_kg: null,
            reason: error.message,
            question: parsed.data.question,
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      throw error;
    }
  }
}
