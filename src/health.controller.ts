import { Controller, Get } from '@nestjs/common';
import { getPool } from './db/pool';

@Controller('health')
export class HealthController {
  /**
   * Proves the wiring before any logic exists: the process is up and it can
   * reach Postgres. If this fails, nothing downstream is worth debugging.
   */
  @Get()
  async check() {
    const result = await getPool().query('SELECT 1 AS ok');
    return { ok: result.rows[0].ok === 1, database: 'reachable' };
  }
}
