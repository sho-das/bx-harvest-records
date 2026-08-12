import { Controller, Get, Header } from '@nestjs/common';
import { PAGE } from './page';

/**
 * Serves one HTML page at GET /.
 *
 * No `@nestjs/serve-static`. That package exists to serve a directory of built
 * assets, and there is one page here with no build step behind it. A dependency
 * to explain is worse than four lines to read.
 *
 * The page is a string imported from `page.ts`, not a file read from disk. See
 * that file for why.
 */
@Controller()
export class UiController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(): string {
    return PAGE;
  }
}
