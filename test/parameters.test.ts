import { beforeAll, describe, expect, it } from 'vitest';

import { diffDocuments, parseSpec, type DiffResult } from '../src/index.js';

import { diffFixture, one } from './helpers.js';

const SOURCES = {
  old: { input: 'old', kind: 'file' as const },
  new: { input: 'new', kind: 'file' as const },
};

describe('request parameter changes', () => {
  let result: DiffResult;
  beforeAll(async () => {
    result = await diffFixture('parameters');
  });

  it('treats a new required parameter as breaking', () => {
    const change = one(result, 'parameter.added.required');
    expect(change.message).toContain('"page"');
    expect(change.severity).toBe('breaking');
    expect(change.direction).toBe('request');
  });

  it('treats a new optional parameter as additive', () => {
    const change = one(result, 'parameter.added.optional');
    expect(change.message).toContain('"verbose"');
    expect(change.severity).toBe('additive');
  });

  it('treats optional becoming required as breaking', () => {
    const change = one(result, 'parameter.required.added');
    expect(change.message).toContain('"limit"');
    expect(change.severity).toBe('breaking');
  });

  it('treats required becoming optional as additive', () => {
    const change = one(result, 'parameter.required.removed');
    expect(change.message).toContain('"sort"');
    expect(change.severity).toBe('additive');
  });

  it('treats a removed parameter as a warning rather than a hard break', () => {
    const change = one(result, 'parameter.removed');
    expect(change.message).toContain('"cursor"');
    expect(change.severity).toBe('warning');
  });

  it('reports a newly deprecated parameter as informational', () => {
    expect(one(result, 'parameter.deprecated').severity).toBe('informational');
  });

  it('does not report the unchanged path-level parameter', () => {
    expect(result.changes.some((c) => c.message.includes('tenant'))).toBe(false);
  });

  it('applies path-level parameters to every operation on the path', () => {
    // `tenant` is declared once on the path item but constrains both operations.
    const before = parseSpec(`
openapi: 3.0.3
info: { title: t, version: '1' }
paths:
  /x:
    parameters:
      - { name: tenant, in: header, required: true, schema: { type: string } }
    get: { responses: { '200': { description: ok } } }
`);
    const after = parseSpec(`
openapi: 3.0.3
info: { title: t, version: '2' }
paths:
  /x:
    get: { responses: { '200': { description: ok } } }
`);
    const diff = diffDocuments(before, after, SOURCES);
    const change = one(diff, 'parameter.removed');
    expect(change.message).toContain('tenant');
    expect(change.method).toBe('get');
  });

  it('lets an operation-level parameter override the inherited one', () => {
    const before = parseSpec(`
openapi: 3.0.3
info: { title: t, version: '1' }
paths:
  /x:
    parameters:
      - { name: tenant, in: header, required: false, schema: { type: string } }
    get:
      parameters:
        - { name: tenant, in: header, required: true, schema: { type: string } }
      responses: { '200': { description: ok } }
`);
    const after = parseSpec(`
openapi: 3.0.3
info: { title: t, version: '2' }
paths:
  /x:
    parameters:
      - { name: tenant, in: header, required: false, schema: { type: string } }
    get:
      responses: { '200': { description: ok } }
`);
    const diff = diffDocuments(before, after, SOURCES);
    // Effective requiredness went true -> false, so this is a relaxation, not a
    // removal: the parameter still exists via the path item.
    expect(one(diff, 'parameter.required.removed').severity).toBe('additive');
  });

  it('distinguishes parameters that share a name but differ in location', () => {
    const before = parseSpec(`
openapi: 3.0.3
info: { title: t, version: '1' }
paths:
  /x:
    get:
      parameters:
        - { name: id, in: query, required: true, schema: { type: string } }
      responses: { '200': { description: ok } }
`);
    const after = parseSpec(`
openapi: 3.0.3
info: { title: t, version: '2' }
paths:
  /x:
    get:
      parameters:
        - { name: id, in: header, required: true, schema: { type: string } }
      responses: { '200': { description: ok } }
`);
    const diff = diffDocuments(before, after, SOURCES);
    expect(one(diff, 'parameter.removed').message).toContain('query');
    expect(one(diff, 'parameter.added.required').message).toContain('header');
  });

  it('resolves parameters declared through a $ref', () => {
    const before = parseSpec(`
openapi: 3.0.3
info: { title: t, version: '1' }
paths:
  /x:
    get:
      parameters:
        - $ref: '#/components/parameters/Page'
      responses: { '200': { description: ok } }
components:
  parameters:
    Page:
      name: page
      in: query
      required: false
      schema: { type: integer }
`);
    const after = parseSpec(`
openapi: 3.0.3
info: { title: t, version: '2' }
paths:
  /x:
    get:
      parameters:
        - $ref: '#/components/parameters/Page'
      responses: { '200': { description: ok } }
components:
  parameters:
    Page:
      name: page
      in: query
      required: true
      schema: { type: integer }
`);
    const diff = diffDocuments(before, after, SOURCES);
    expect(one(diff, 'parameter.required.added').severity).toBe('breaking');
  });
});
