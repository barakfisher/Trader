/**
 * Import preview and commit (FLOWS.md F1).
 *
 * Preview parses, validates and resolves without touching the database; commit
 * writes the rows the user selected. The two-step shape is what makes "23 rows
 * fine, 2 need your attention" possible instead of an opaque success or failure.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import type { ImportCommitRequest } from '@traders/shared';

import { getUser } from '../../db/queries.js';
import { commitImport } from '../../services/importCommit.js';
import { ImportParseError, buildImportRows, countByStatus } from '../../services/importer.js';
import { deletePreview, getPreview, savePreview } from '../../services/previewStore.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound, unprocessable } from '../errors.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const commitSchema = z.object({
  previewId: z.string().uuid(),
  mode: z.enum(['merge', 'replace']),
  lines: z.array(z.number().int().positive()).max(5000),
  symbolOverrides: z.record(z.string(), z.string()).optional(),
});

export function registerImportRoutes(app: Hono<AppEnv>): void {
  app.post('/imports/preview', async (context) => {
    const userId = currentUserId(context);
    const user = await getUser(userId);
    if (!user) throw notFound('user not found');

    const { content, filename } = await readUpload(context);
    if (content.length > MAX_FILE_BYTES) {
      throw badRequest('file_too_large', `file exceeds ${MAX_FILE_BYTES} bytes`);
    }

    let rows;
    try {
      rows = await buildImportRows({
        content,
        filename,
        defaultCurrency: user.base_currency,
        ai: context.get('ai'),
        requestId: context.get('requestId'),
      });
    } catch (error) {
      if (error instanceof ImportParseError) {
        // The whole file is unusable - this is the only all-or-nothing failure.
        throw unprocessable('unparseable_file', error.message);
      }
      throw error;
    }

    const preview = savePreview(userId, { filename, rows, counts: countByStatus(rows) });
    return context.json(preview, 201);
  });

  app.post('/imports/commit', async (context) => {
    const userId = currentUserId(context);
    const parsed = commitSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'commit payload failed validation', parsed.error.issues);
    }

    const preview = getPreview(userId, parsed.data.previewId);
    if (!preview) {
      throw notFound('this preview has expired or does not exist; upload the file again');
    }

    const request: ImportCommitRequest = {
      previewId: parsed.data.previewId,
      mode: parsed.data.mode,
      lines: parsed.data.lines,
      symbolOverrides: parsed.data.symbolOverrides
        ? Object.fromEntries(
            Object.entries(parsed.data.symbolOverrides).map(([line, symbol]) => [Number(line), symbol]),
          )
        : undefined,
    };

    const result = await commitImport(userId, preview, request);
    deletePreview(parsed.data.previewId);
    return context.json(result);
  });
}

/**
 * Accept either a multipart upload (field `file`) or a JSON body
 * `{ filename, content }`, so the UI and a curl one-liner can use the same route.
 */
async function readUpload(context: {
  req: {
    header: (name: string) => string | undefined;
    parseBody: () => Promise<Record<string, unknown>>;
    json: () => Promise<unknown>;
  };
}): Promise<{ content: string; filename: string }> {
  const contentType = context.req.header('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const body = await context.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw badRequest('missing_file', 'expected a multipart field named "file"');
    return { content: await file.text(), filename: file.name || 'upload.csv' };
  }

  const json = (await context.req.json().catch(() => null)) as
    | { filename?: string; content?: string }
    | null;
  if (!json?.content) {
    throw badRequest('missing_content', 'expected multipart "file" or JSON { filename, content }');
  }
  return { content: json.content, filename: json.filename ?? 'upload.csv' };
}
