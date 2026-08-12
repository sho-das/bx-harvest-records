import { BadRequestException, Body, Controller, Logger, Post } from '@nestjs/common';
import { z } from 'zod';
import { join } from 'node:path';
import { getPool } from '../db/pool';
import { importCsv, decisionKey } from '../import/import';
import { SOURCE_FILE, squashed } from '../import/rules';

const DecisionBody = z.object({
  line: z.number().int().positive(),
  field: z.enum(['unit', 'harvest_date', 'quantity', 'duplicate', 'variety']),
  label: z.string().trim().min(1).max(200),
});

/**
 * The second endpoint, and the first one that writes.
 *
 * Until this existed the page could show what an answer would become and then
 * do nothing with it, and the next import asked the same question again. A
 * system that asks once is answering a question. A system that asks every time
 * has not been told anything.
 *
 * What it records is a decision, not a value on a row. The difference matters
 * on the next import: the decision is looked up and applied by the same code
 * that would have parked the row, so there is one place that decides what a
 * row means and it is not this file.
 *
 * Two scopes, chosen by the field:
 *
 *   variety  -> 'spelling'. The subject is the token as written. "sweethart
 *               means Sweetheart" is true of every file, so answering it once
 *               improves every import that follows.
 *   anything -> 'row'. The subject is the row as written, so the decision
 *   else       follows the row rather than its line number.
 *
 * Re-importing after the write is deliberate. Applying the decision here in a
 * second place would be a second implementation of "what does this row mean",
 * and the two would disagree eventually. 26 rows is cheap.
 */
@Controller('decision')
export class DecisionController {
  private readonly log = new Logger(DecisionController.name);

  @Post()
  async post(@Body() body: unknown) {
    const parsed = DecisionBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        recorded: false,
        reason: `The body needs line, field and label: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      });
    }
    const { line, field, label } = parsed.data;

    const pool = getPool();
    const found = await pool.query(
      `SELECT r.row_subject, r.variety_raw, o.quantity_kg::text AS quantity_kg,
              o.harvest_date::text AS harvest_date, o.variety, o.keeps_row_out
         FROM harvest_record r
         JOIN parked_question q ON q.record_id = r.id AND q.field = $3
         JOIN parked_option  o ON o.question_id = q.id AND o.label = $4
        WHERE r.source_file = $1 AND r.source_line = $2`,
      [SOURCE_FILE, line, field, label],
    );

    if (found.rowCount === 0) {
      throw new BadRequestException({
        recorded: false,
        reason: `Line ${line} has no question about ${field} with an option called "${label}".`,
      });
    }

    const option = found.rows[0];
    const spelling = field === 'variety';
    const subject = spelling ? squashed(option.variety_raw ?? '') : option.row_subject;

    if (!subject) {
      throw new BadRequestException({
        recorded: false,
        reason: `Line ${line} has nothing written in that field, so there is no decision to record.`,
      });
    }

    await pool.query(
      `INSERT INTO decision (scope, field, subject, chosen_label, quantity_kg, harvest_date, variety)
       VALUES ($1, $2, $3, $4, $5::numeric, $6::date, $7)
       ON CONFLICT (scope, field, subject) DO UPDATE
          SET chosen_label = EXCLUDED.chosen_label,
              quantity_kg  = EXCLUDED.quantity_kg,
              harvest_date = EXCLUDED.harvest_date,
              variety      = EXCLUDED.variety,
              decided_at   = now()`,
      [
        spelling ? 'spelling' : 'row',
        field,
        subject,
        label,
        option.quantity_kg,
        option.harvest_date,
        option.variety,
      ],
    );

    this.log.log(`decision: line ${line} ${field} = "${label}" (${spelling ? 'spelling' : 'row'})`);

    // Applied by the importer, so there is one implementation of what a
    // decision does to a row.
    const report = await importCsv(join(process.cwd(), 'data', SOURCE_FILE));

    return {
      recorded: true,
      decision: { line, field, chosen: label, scope: spelling ? 'spelling' : 'row', subject },
      after_import: { counted: report.counted, parked: report.parked },
    };
  }
}
