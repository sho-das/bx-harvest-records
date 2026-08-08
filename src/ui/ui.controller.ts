import { Controller, Get, Header, InternalServerErrorException } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Serves one HTML file at GET /.
 *
 * No `@nestjs/serve-static`. That package exists to serve a directory of built
 * assets, and there is one file here with no build step behind it. A dependency
 * to explain is worse than six lines to read.
 *
 * The file is read on every request rather than cached. There is no bundler, so
 * editing `public/index.html` and refreshing the browser is the whole loop. On
 * a page that is served to one person on localhost, a stat and a read per
 * request costs nothing worth measuring.
 */
const CANDIDATES = [
  // running the compiled output: dist/src/ui -> project root
  join(__dirname, '..', '..', '..', 'public', 'index.html'),
  // running from source under tsx: src/ui -> project root
  join(__dirname, '..', '..', 'public', 'index.html'),
  // last resort, and the same assumption `npm run migrate` already makes
  join(process.cwd(), 'public', 'index.html'),
];

@Controller()
export class UiController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(): string {
    const found = CANDIDATES.find((path) => existsSync(path));
    if (!found) {
      throw new InternalServerErrorException(
        `public/index.html was not found. Looked in: ${CANDIDATES.join(', ')}`,
      );
    }
    return readFileSync(found, 'utf8');
  }
}
