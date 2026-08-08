/**
 * Applies every .sql file in src/db/migrations, in filename order.
 *
 * This exists because `psql "$DATABASE_URL" -f ...` in an npm script reads the
 * shell, not `.env`. dotenv only runs inside a node process, so the two other
 * scripts picked up `.env` and this one silently did not. Anyone following the
 * README from a clean shell hit an unset variable.
 *
 * An unset variable is not the dangerous part. `psql ""` does not fail on an
 * empty connection string - it falls back to every default it has, including a
 * database named after the current user. On a machine where that database
 * happens to exist, the tables get created in the wrong place and nothing says
 * so. This script refuses to run without DATABASE_URL, and prints the database
 * it is about to touch before it touches it.
 *
 * Still psql, still plain .sql files (D2). The only thing added is the
 * environment and a check.
 *
 * Every file is re-applied on every run. That is safe because each one is
 * written to be idempotent, and it is the deliberate limit: there is no table
 * recording what has been applied, because there is one migration.
 */

import { config } from 'dotenv';
config();

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS = resolve('src/db/migrations');

function databaseName(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\//, '');
    return path || '(none named in DATABASE_URL)';
  } catch {
    return '(could not read a database name from DATABASE_URL)';
  }
}

function main(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_URL is not set.\n' +
        '\n' +
        '  cp .env.example .env      and fill it in\n' +
        '\n' +
        'Refusing to run: psql treats an empty connection string as "use every\n' +
        'default", which on some machines means a database named after you. That\n' +
        'would create these tables somewhere nobody asked for.',
    );
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.error(`No .sql files in ${MIGRATIONS}`);
    process.exit(1);
  }

  console.log(`Applying ${files.length} migration(s) to ${databaseName(url)}`);

  for (const file of files) {
    console.log(`  ${file}`);
    const result = spawnSync(
      'psql',
      [url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', join(MIGRATIONS, file)],
      { stdio: 'inherit' },
    );

    if (result.error) {
      console.error(`Could not run psql: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`${file} failed. Nothing after it was applied.`);
      process.exit(result.status ?? 1);
    }
  }

  console.log('Done.');
}

main();
