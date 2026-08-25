import { describe, expect, it } from 'vitest';

import { normalizeType } from '../src/index.js';

import { diffText, kindsOf, one, responseSpec } from './helpers.js';

describe('schema comparison', () => {
  it('treats 3.0 nullable and 3.1 type-union spellings as the same contract', () => {
    expect(normalizeType({ type: 'string', nullable: true })).toEqual(
      normalizeType({ type: ['string', 'null'] }),
    );
    const diff = diffText(
      responseSpec('1', 'type: string\nnullable: true'),
      responseSpec('2', "type: ['string', 'null']"),
    );
    expect(kindsOf(diff)).toEqual([]);
  });

  it('does not report a type change when only nullability differs', () => {
    const diff = diffText(
      responseSpec('1', 'type: string'),
      responseSpec('2', "type: ['string', 'null']"),
    );
    expect(kindsOf(diff)).toEqual(['schema.nullable.added']);
  });

  it('flattens allOf so inherited properties are compared, not the branches', () => {
    const before = `openapi: 3.0.3
info: { title: T, version: '1' }
paths:
  /x:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/Base'
                  - type: object
                    properties:
                      extra: { type: string }
components:
  schemas:
    Base:
      type: object
      required: [id]
      properties:
        id: { type: string }
`;
    // Same effective shape, written inline instead of through allOf.
    const after = `openapi: 3.0.3
info: { title: T, version: '2' }
paths:
  /x:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id]
                properties:
                  id: { type: string }
                  extra: { type: string }
`;
    expect(kindsOf(diffText(before, after))).toEqual([]);
  });

  it('reports a property removed from an allOf branch', () => {
    const spec = (version: string, extra: string): string => `openapi: 3.0.3
info: { title: T, version: '${version}' }
paths:
  /x:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                allOf:
                  - type: object
                    properties:
                      id: { type: string }
                  - type: object
                    properties:
${extra}
`;
    const diff = diffText(
      spec('1', '                      extra: { type: string }'),
      spec('2', '                      other: { type: string }'),
    );
    expect(kindsOf(diff).sort()).toEqual(['schema.property.added', 'schema.property.removed']);
  });

  it('terminates on mutually recursive schemas', () => {
    const spec = (version: string, leafType: string): string => `openapi: 3.0.3
info: { title: T, version: '${version}' }
paths:
  /x:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Node'
components:
  schemas:
    Node:
      type: object
      properties:
        name: { type: ${leafType} }
        children:
          type: array
          items:
            $ref: '#/components/schemas/Node'
        owner:
          $ref: '#/components/schemas/Owner'
    Owner:
      type: object
      properties:
        favourite:
          $ref: '#/components/schemas/Node'
`;
    const diff = diffText(spec('1', 'string'), spec('2', 'integer'));
    // The point is that this returns at all; the change is found once at the top.
    expect(kindsOf(diff)).toContain('schema.type.changed');
    expect(diff.changes.length).toBeLessThan(10);
  });

  it('descends into array items and names them with []', () => {
    const diff = diffText(
      responseSpec('1', 'type: array\nitems:\n  type: object\n  properties:\n    id: { type: string }'),
      responseSpec('2', 'type: array\nitems:\n  type: object\n  properties:\n    id: { type: integer }'),
    );
    const change = one(diff, 'schema.type.changed');
    expect(change.message).toContain('[].id');
    expect(change.pointer).toContain('/items/properties/id');
  });

  it('classifies a tightened bound by direction', () => {
    const response = diffText(
      responseSpec('1', 'type: integer\nmaximum: 100'),
      responseSpec('2', 'type: integer\nmaximum: 50'),
    );
    expect(one(response, 'schema.constraint.tightened').severity).toBe('warning');

    const request = diffText(
      requestSpec('1', 'type: integer\nmaximum: 100'),
      requestSpec('2', 'type: integer\nmaximum: 50'),
    );
    expect(one(request, 'schema.constraint.tightened').severity).toBe('breaking');
  });

  it('classifies a relaxed bound by direction', () => {
    const request = diffText(
      requestSpec('1', 'type: string\nminLength: 5'),
      requestSpec('2', 'type: string\nminLength: 2'),
    );
    expect(one(request, 'schema.constraint.relaxed').severity).toBe('additive');
  });

  it('ignores the boolean spelling of exclusiveMinimum from OpenAPI 3.0', () => {
    const diff = diffText(
      responseSpec('1', 'type: number\nminimum: 0\nexclusiveMinimum: true'),
      responseSpec('2', 'type: number\nminimum: 0\nexclusiveMinimum: true'),
    );
    expect(kindsOf(diff)).toEqual([]);
  });

  it('reports a format change as a warning it cannot prove either way', () => {
    const diff = diffText(
      responseSpec('1', 'type: integer\nformat: int32'),
      responseSpec('2', 'type: integer\nformat: int64'),
    );
    const change = one(diff, 'schema.format.changed');
    expect(change.severity).toBe('warning');
    expect(change.from).toBe('int32');
    expect(change.to).toBe('int64');
  });

  it('reports a changed oneOf branch count as a composition change', () => {
    const diff = diffText(
      responseSpec('1', 'oneOf:\n  - type: string\n  - type: integer'),
      responseSpec('2', 'oneOf:\n  - type: string'),
    );
    const change = one(diff, 'schema.composition.changed');
    expect(change.severity).toBe('warning');
    expect(change.from).toBe('2');
    expect(change.to).toBe('1');
  });

  it('compares same-arity oneOf branches positionally', () => {
    const diff = diffText(
      responseSpec('1', 'oneOf:\n  - type: string\n  - type: integer'),
      responseSpec('2', 'oneOf:\n  - type: string\n  - type: boolean'),
    );
    expect(one(diff, 'schema.type.changed').pointer).toContain('/oneOf/1');
  });

  it('reports a newly introduced enum as a tightening', () => {
    const diff = diffText(
      requestSpec('1', 'type: string'),
      requestSpec('2', 'type: string\nenum: [a, b]'),
    );
    expect(one(diff, 'schema.constraint.tightened').severity).toBe('breaking');
  });
});

/** A minimal document whose request body carries the given schema. */
function requestSpec(version: string, schemaYaml: string): string {
  const indented = schemaYaml
    .trim()
    .split('\n')
    .map((line) => `              ${line}`)
    .join('\n');
  return `openapi: 3.0.3
info:
  title: T
  version: '${version}'
paths:
  /x:
    post:
      operationId: postX
      requestBody:
        required: true
        content:
          application/json:
            schema:
${indented}
      responses:
        '200':
          description: ok
`;
}
