import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  diffDocuments,
  diffSpecs,
  parseSpec,
  type Change,
  type DiffResult,
} from '../src/index.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Path to a file inside the fixture tree. */
export function fixture(...segments: string[]): string {
  return join(FIXTURES, ...segments);
}

/** Diff the `old.yaml`/`new.yaml` pair in a fixture directory. */
export function diffFixture(name: string): Promise<DiffResult> {
  return diffSpecs(fixture(name, 'old.yaml'), fixture(name, 'new.yaml'));
}

/** Every change kind present in a report. */
export function kindsOf(result: DiffResult): string[] {
  return result.changes.map((c) => c.kind);
}

/**
 * Find the single change matching a kind and optional filters.
 *
 * Throws when there is no match or more than one, so a test that silently
 * matched the wrong change fails loudly instead.
 */
export function one(
  result: DiffResult,
  kind: string,
  where: Partial<Pick<Change, 'path' | 'method' | 'pointer'>> = {},
): Change {
  const matches = result.changes.filter(
    (c) =>
      c.kind === kind &&
      (where.path === undefined || c.path === where.path) &&
      (where.method === undefined || c.method === where.method) &&
      (where.pointer === undefined || c.pointer === where.pointer),
  );
  if (matches.length !== 1) {
    const seen = result.changes
      .filter((c) => c.kind === kind)
      .map((c) => `${c.kind} @ ${c.pointer}`)
      .join('\n  ');
    throw new Error(
      `expected exactly one "${kind}" matching ${JSON.stringify(where)}, found ${matches.length}.` +
        (seen ? `\n  ${seen}` : ''),
    );
  }
  return matches[0] as Change;
}

/** All changes of a kind, in report order. */
export function all(result: DiffResult, kind: string): Change[] {
  return result.changes.filter((c) => c.kind === kind);
}

const INLINE_SOURCES = {
  old: { input: 'old', kind: 'file' as const },
  new: { input: 'new', kind: 'file' as const },
};

/** Diff two inline spec documents written as YAML or JSON text. */
export function diffText(oldText: string, newText: string): DiffResult {
  return diffDocuments(parseSpec(oldText, 'old'), parseSpec(newText, 'new'), INLINE_SOURCES);
}

/** Wrap schema YAML in a minimal document exercising a response body. */
export function responseSpec(version: string, schemaYaml: string): string {
  const indented = schemaYaml
    .trim()
    .split('\n')
    .map((line) => `                ${line}`)
    .join('\n');
  return `openapi: 3.0.3
info:
  title: T
  version: '${version}'
paths:
  /x:
    get:
      operationId: getX
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
${indented}
`;
}
