import { beforeAll, describe, expect, it } from 'vitest';

import type { DiffResult } from '../src/index.js';

import { diffFixture, one } from './helpers.js';

describe('request body and request schema changes', () => {
  let result: DiffResult;
  beforeAll(async () => {
    result = await diffFixture('bodies');
  });

  it('treats a body becoming required as breaking', () => {
    expect(one(result, 'requestBody.required.added').severity).toBe('breaking');
  });

  it('treats a dropped media type as breaking', () => {
    const change = one(result, 'requestBody.mediaType.removed');
    expect(change.message).toContain('application/xml');
    expect(change.severity).toBe('breaking');
  });

  it('treats a retyped property as breaking regardless of direction', () => {
    const change = one(result, 'schema.type.changed');
    expect(change.pointer).toContain('/properties/size');
    expect(change.from).toBe('integer');
    expect(change.to).toBe('string');
    expect(change.severity).toBe('breaking');
  });

  it('treats a newly required existing property as breaking on a request', () => {
    const change = one(result, 'schema.required.added');
    expect(change.message).toContain('"size"');
    expect(change.direction).toBe('request');
    expect(change.severity).toBe('breaking');
  });

  it('treats a new required property as breaking on a request', () => {
    const change = one(result, 'schema.property.added.required');
    expect(change.message).toContain('"sku"');
    expect(change.severity).toBe('breaking');
  });

  it('treats a new optional property as additive', () => {
    const change = one(result, 'schema.property.added');
    expect(change.message).toContain('"weight"');
    expect(change.severity).toBe('additive');
  });

  it('treats a removed request property as a warning, not a break', () => {
    const change = one(result, 'schema.property.removed');
    expect(change.message).toContain('"tags"');
    expect(change.severity).toBe('warning');
  });

  it('treats a widened request enum as additive and a narrowed one as breaking', () => {
    expect(one(result, 'schema.enum.value.added').severity).toBe('additive');
    expect(one(result, 'schema.enum.value.removed').severity).toBe('breaking');
  });

  it('treats newly forbidden extra properties as breaking on a request', () => {
    const change = one(result, 'schema.additionalProperties.restricted');
    expect(change.pointer).toContain('/properties/meta');
    expect(change.severity).toBe('breaking');
  });

  it('follows $ref into components when comparing schemas', () => {
    // Every schema change above lives behind `$ref: '#/components/schemas/WidgetInput'`.
    expect(result.changes.filter((c) => c.area === 'schema').length).toBeGreaterThan(0);
  });

  it('marks every schema change under a request body as request-directed', () => {
    for (const change of result.changes.filter((c) => c.area === 'schema')) {
      expect(change.direction).toBe('request');
    }
  });
});
