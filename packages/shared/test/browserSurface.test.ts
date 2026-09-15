/**
 * zod is a runtime dependency of this package, and this package is imported by
 * the browser app. The `.` export (`src/index.ts`) is what the web app consumes;
 * only the `./ai` export, which the orchestrator uses, is allowed to reach for
 * zod. Nothing enforced that division except habit, so this test walks the
 * module graph under the `.` entry point and fails if any file in it imports
 * something that is not a sibling source file - zod today, anything else
 * tomorrow. Imports in ESM are static, so reading them is enough.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = resolve(packageRoot, 'src/index.ts');

const IMPORT_PATTERN = /(?:from|import)\s*['"]([^'"]+)['"]/g;

/** Specifiers reachable from `entry`, split into relative files and bare packages. */
function collectGraph(entry: string): { files: string[]; packages: string[] } {
  const visited = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1]!;
      if (!specifier.startsWith('.')) {
        packages.add(specifier);
        continue;
      }
      // Source is consumed as TypeScript but written with ESM `.js` specifiers;
      // the generated client only exists as a declaration file.
      const base = resolve(dirname(file), specifier.replace(/\.js$/, ''));
      queue.push(existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.d.ts`);
    }
  }

  return {
    files: [...visited].map((file) => relative(packageRoot, file)).sort(),
    packages: [...packages].sort(),
  };
}

describe('the browser-facing entry point', () => {
  const graph = collectGraph(entryPoint);

  it('pulls in no runtime dependency at all, zod included', () => {
    expect(graph.packages).toEqual([]);
  });

  it('does not reach the AI client, which is where zod lives', () => {
    expect(graph.files.filter((file) => file.includes('src/ai/'))).toEqual([]);
  });

  it('confirms the AI client really is the only zod consumer here', () => {
    // A guard that fails loudly if zod is later dropped or moved: without this,
    // the assertions above would still pass if nothing imported zod at all.
    expect(collectGraph(resolve(packageRoot, 'src/ai/client.ts')).packages).toContain('zod');
  });
});
