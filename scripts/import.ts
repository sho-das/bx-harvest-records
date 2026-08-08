import { config } from 'dotenv';
config();

import { resolve } from 'node:path';
import { importCsv } from '../src/import/import';
import { closePool } from '../src/db/pool';
import { SOURCE_FILE } from '../src/import/rules';

async function main() {
  const path = resolve(process.argv[2] ?? `data/${SOURCE_FILE}`);
  console.log(`Reading ${path}`);

  const report = await importCsv(path);

  console.log('');
  console.log(`  data lines read ${report.linesRead}`);
  console.log(`  counted         ${report.counted}`);
  console.log(`  parked          ${report.parked}`);
  console.log(`  superseded      ${report.superseded}`);
  console.log(`  not a record    ${report.notARecord}`);
  console.log('');
  console.log(`  corrections linked     ${report.correctionsLinked}`);
  console.log(`  corrections unmatched  ${report.correctionsUnmatched}`);

  await closePool();
}

main().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
