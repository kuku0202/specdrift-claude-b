import { RefResolver, pointerJoin } from '../refs.js';
import type { Direction, Schema } from '../types.js';

import type { DiffContext, Loc } from './context.js';

/** A location that is definitely on one side of the request/response contract. */
export interface SchemaLoc extends Loc {
  direction: Direction;
  /**
   * Human-readable name for the schema root, such as `request body` or
   * `query parameter "q"`. Messages are built from this so a reader can tell
   * which of an operation's several schemas a change refers to.
   */
  subject: string;
  /** Dotted path from the schema root to the changed member, e.g. `owner.id`. */
  field?: string;
}

/** Describe the exact thing a change refers to, for use in a message. */
export function where(loc: SchemaLoc): string {
  return loc.field === undefined ? loc.subject : `${loc.subject} property "${loc.field}"`;
}

/** Extend a location's field path by one segment. */
function descend(loc: SchemaLoc, segment: string, pointerSegments: (string | number)[]): SchemaLoc {
  const field = loc.field === undefined ? segment : `${loc.field}.${segment}`;
  return { ...loc, field, pointer: pointerJoin(loc.pointer, ...pointerSegments) };
}

interface WalkState {
  depth: number;
  /** `$ref` pairs on the current branch, for cycle detection. */
  seen: Set<string>;
}

/** The type of a schema, with nullability normalised across 3.0 and 3.1. */
interface NormalizedType {
  /** Declared types excluding `null`. Empty when the schema declares none. */
  types: string[];
  nullable: boolean;
  declared: boolean;
}

/**
 * Normalise a schema's type.
 *
 * OpenAPI 3.0 spells an optional-null as `type: string` plus `nullable: true`;
 * 3.1 spells it `type: [string, 'null']`. Both mean the same thing, and a spec
 * that migrates from one to the other has not changed its contract.
 */
export function normalizeType(schema: Schema): NormalizedType {
  const raw = schema.type;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const types = list.filter((t) => t !== 'null').sort();
  const nullable = schema.nullable === true || list.includes('null');
  return { types, nullable, declared: raw !== undefined };
}

/**
 * Collapse `allOf` into a single effective schema.
 *
 * Real specifications lean on `allOf` for inheritance ("this response is a
 * `user` plus two extra fields"). Comparing the branches positionally would
 * report noise whenever they are reordered, so specdrift merges them into the
 * shape a client actually sees. Branches that carry `oneOf`/`anyOf` cannot be
 * merged this way and are left in place for the composition check to notice.
 */
export function flattenSchema(
  schema: Schema,
  refs: RefResolver,
  depth = 0,
  seen: Set<string> = new Set(),
): Schema {
  const resolved = refs.resolve(schema);
  const node = resolved.value;
  if (resolved.ref !== undefined) {
    if (seen.has(resolved.ref)) return node;
    seen.add(resolved.ref);
  }
  const branches = node.allOf;
  if (!Array.isArray(branches) || branches.length === 0 || depth > 12) return node;

  const merged: Schema = { ...node };
  delete merged.allOf;
  const properties: Record<string, Schema | undefined> = {};
  const required = new Set<string>(Array.isArray(node.required) ? node.required : []);

  for (const branch of branches) {
    if (branch === null || typeof branch !== 'object') continue;
    const flat = flattenSchema(branch, refs, depth + 1, new Set(seen));
    if (flat.oneOf || flat.anyOf) {
      // Not mergeable: keep the branch so composition.changed can report it.
      (merged.allOf ??= []).push(flat);
      continue;
    }
    Object.assign(properties, flat.properties ?? {});
    for (const name of flat.required ?? []) required.add(name);
    if (merged.type === undefined && flat.type !== undefined) merged.type = flat.type;
    if (merged.format === undefined && flat.format !== undefined) {
      merged.format = flat.format;
    }
    if (flat.nullable === true) merged.nullable = true;
    if (merged.items === undefined && flat.items !== undefined) merged.items = flat.items;
    if (merged.additionalProperties === undefined && flat.additionalProperties !== undefined) {
      merged.additionalProperties = flat.additionalProperties;
    }
  }

  // The outer schema's own properties win over any inherited from a branch.
  Object.assign(properties, node.properties ?? {});
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required].sort();
  return merged;
}

/** Constraints that shrink the accepted value space when they increase. */
const LOWER_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'] as const;
/** Constraints that shrink the accepted value space when they decrease. */
const UPPER_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'] as const;

/**
 * Compare two schemas and record every difference on `ctx`.
 *
 * @param oldSchema - Schema from the old document, or `undefined` if absent.
 * @param newSchema - Schema from the new document, or `undefined` if absent.
 * @param ctx - Diff run state.
 * @param loc - Where this schema sits, including which side of the contract.
 */
export function diffSchema(
  oldSchema: Schema | undefined,
  newSchema: Schema | undefined,
  ctx: DiffContext,
  loc: SchemaLoc,
  state: WalkState = { depth: 0, seen: new Set() },
): void {
  if (oldSchema === undefined && newSchema === undefined) return;

  if (oldSchema === undefined || newSchema === undefined) {
    const added = newSchema !== undefined;
    ctx.add(
      'schema.composition.changed',
      loc,
      added
        ? `${loc.subject} is now constrained by a schema where it declared none`
        : `${loc.subject} no longer declares a schema`,
    );
    return;
  }

  // Fast path: prove the subtrees identical and skip the detailed walk.
  if (ctx.equal(oldSchema, newSchema)) return;

  const oldRef = RefResolver.isRef(oldSchema) ? oldSchema.$ref : '';
  const newRef = RefResolver.isRef(newSchema) ? newSchema.$ref : '';
  if (oldRef !== '' && newRef !== '') {
    const key = `${oldRef} ${newRef}`;
    if (state.seen.has(key)) return; // recursive schema; already being compared
    state = { depth: state.depth, seen: new Set(state.seen).add(key) };
  }

  if (state.depth > ctx.maxDepth) return;

  const oldFlat = flattenSchema(oldSchema, ctx.oldRefs);
  const newFlat = flattenSchema(newSchema, ctx.newRefs);
  const next: WalkState = { depth: state.depth + 1, seen: state.seen };

  diffType(oldFlat, newFlat, ctx, loc);
  diffEnum(oldFlat, newFlat, ctx, loc);
  diffConstraints(oldFlat, newFlat, ctx, loc);
  diffAdditionalProperties(oldFlat, newFlat, ctx, loc);
  diffComposition(oldFlat, newFlat, ctx, loc, next);
  diffProperties(oldFlat, newFlat, ctx, loc, next);

  if (oldFlat.items || newFlat.items) {
    diffSchema(oldFlat.items, newFlat.items, ctx, itemLoc(loc), next);
  }
}

function itemLoc(loc: SchemaLoc): SchemaLoc {
  // `tags[]` reads better than `tags.items` when naming an array's element.
  const field = loc.field === undefined ? '[]' : `${loc.field}[]`;
  return { ...loc, field, pointer: pointerJoin(loc.pointer, 'items') };
}

function diffType(
  oldFlat: Schema,
  newFlat: Schema,
  ctx: DiffContext,
  loc: SchemaLoc,
): void {
  const before = normalizeType(oldFlat);
  const after = normalizeType(newFlat);

  if (
    before.declared &&
    after.declared &&
    before.types.join(',') !== after.types.join(',')
  ) {
    ctx.add('schema.type.changed', loc, `${where(loc)} changed type`, {
      from: before.types.join(' | ') || '(none)',
      to: after.types.join(' | ') || '(none)',
    });
  }

  if (before.nullable !== after.nullable) {
    ctx.add(
      after.nullable ? 'schema.nullable.added' : 'schema.nullable.removed',
      loc,
      `${where(loc)} ${after.nullable ? 'became nullable' : 'is no longer nullable'}`,
    );
  }

  const oldFormat = typeof oldFlat.format === 'string' ? oldFlat.format : undefined;
  const newFormat = typeof newFlat.format === 'string' ? newFlat.format : undefined;
  if (oldFormat !== newFormat) {
    ctx.add('schema.format.changed', loc, `${where(loc)} changed format`, {
      from: oldFormat ?? '(none)',
      to: newFormat ?? '(none)',
    });
  }
}

function diffEnum(
  oldFlat: Schema,
  newFlat: Schema,
  ctx: DiffContext,
  loc: SchemaLoc,
): void {
  const before = new Set((oldFlat.enum ?? []).map((v) => JSON.stringify(v)));
  const after = new Set((newFlat.enum ?? []).map((v) => JSON.stringify(v)));
  if (before.size === 0 && after.size === 0) return;

  // An enum appearing where there was none is a tightening, not "values removed".
  if (before.size === 0) {
    ctx.add('schema.constraint.tightened', loc, `${where(loc)} is now restricted to an enum`, {
      to: [...after].join(', '),
    });
    return;
  }
  if (after.size === 0) {
    ctx.add('schema.constraint.relaxed', loc, `${where(loc)} is no longer restricted to an enum`, {
      from: [...before].join(', '),
    });
    return;
  }

  const added = [...after].filter((v) => !before.has(v));
  const removed = [...before].filter((v) => !after.has(v));
  if (added.length > 0) {
    ctx.add('schema.enum.value.added', loc, `${where(loc)} enum gained ${added.join(', ')}`, {
      to: added.join(', '),
    });
  }
  if (removed.length > 0) {
    ctx.add('schema.enum.value.removed', loc, `${where(loc)} enum lost ${removed.join(', ')}`, {
      from: removed.join(', '),
    });
  }
}

function diffConstraints(
  oldFlat: Schema,
  newFlat: Schema,
  ctx: DiffContext,
  loc: SchemaLoc,
): void {
  for (const key of LOWER_BOUNDS) {
    compareBound(oldFlat[key], newFlat[key], key, 'lower', ctx, loc);
  }
  for (const key of UPPER_BOUNDS) {
    compareBound(oldFlat[key], newFlat[key], key, 'upper', ctx, loc);
  }

  const oldPattern = oldFlat['pattern'];
  const newPattern = newFlat['pattern'];
  if (oldPattern !== newPattern) {
    const relaxed = typeof oldPattern === 'string' && newPattern === undefined;
    ctx.add(
      relaxed ? 'schema.constraint.relaxed' : 'schema.constraint.tightened',
      loc,
      `${where(loc)} ${relaxed ? 'lost its pattern constraint' : 'changed its pattern constraint'}`,
      {
        from: typeof oldPattern === 'string' ? oldPattern : undefined,
        to: typeof newPattern === 'string' ? newPattern : undefined,
      },
    );
  }
}

function compareBound(
  before: unknown,
  after: unknown,
  key: string,
  kind: 'lower' | 'upper',
  ctx: DiffContext,
  loc: SchemaLoc,
): void {
  // `exclusiveMinimum`/`exclusiveMaximum` are booleans in 3.0 and numbers in
  // 3.1. Only the numeric spelling carries a bound worth comparing.
  const oldNum = typeof before === 'number' ? before : undefined;
  const newNum = typeof after === 'number' ? after : undefined;
  if (oldNum === newNum) return;

  let tightened: boolean;
  if (oldNum === undefined) tightened = true; // a bound appeared
  else if (newNum === undefined) tightened = false; // a bound disappeared
  else tightened = kind === 'lower' ? newNum > oldNum : newNum < oldNum;

  ctx.add(
    tightened ? 'schema.constraint.tightened' : 'schema.constraint.relaxed',
    loc,
    `${where(loc)} ${tightened ? 'tightened' : 'relaxed'} its ${key}`,
    { from: oldNum?.toString(), to: newNum?.toString() },
  );
}

function diffAdditionalProperties(
  oldFlat: Schema,
  newFlat: Schema,
  ctx: DiffContext,
  loc: SchemaLoc,
): void {
  // Absent means "allowed" in OpenAPI, so only an explicit `false` restricts.
  const before = oldFlat.additionalProperties !== false;
  const after = newFlat.additionalProperties !== false;
  if (before === after) return;
  ctx.add(
    after ? 'schema.additionalProperties.allowed' : 'schema.additionalProperties.restricted',
    loc,
    `${where(loc)} ${after ? 'now allows' : 'no longer allows'} undeclared properties`,
  );
}

function diffComposition(
  oldFlat: Schema,
  newFlat: Schema,
  ctx: DiffContext,
  loc: SchemaLoc,
  state: WalkState,
): void {
  for (const keyword of ['oneOf', 'anyOf', 'allOf'] as const) {
    const before = oldFlat[keyword];
    const after = newFlat[keyword];
    const beforeLen = Array.isArray(before) ? before.length : 0;
    const afterLen = Array.isArray(after) ? after.length : 0;
    if (beforeLen === 0 && afterLen === 0) continue;

    if (beforeLen !== afterLen) {
      ctx.add(
        'schema.composition.changed',
        loc,
        `${where(loc)} changed its ${keyword} branch count`,
        { from: String(beforeLen), to: String(afterLen) },
      );
      continue;
    }
    // Same arity: compare positionally, which is the only correspondence the
    // document gives us.
    for (let i = 0; i < beforeLen; i += 1) {
      diffSchema(
        (before as Schema[])[i],
        (after as Schema[])[i],
        ctx,
        { ...loc, pointer: pointerJoin(loc.pointer, keyword, i) },
        state,
      );
    }
  }
}

function diffProperties(
  oldFlat: Schema,
  newFlat: Schema,
  ctx: DiffContext,
  loc: SchemaLoc,
  state: WalkState,
): void {
  const before = oldFlat.properties ?? {};
  const after = newFlat.properties ?? {};
  const beforeRequired = new Set(oldFlat.required ?? []);
  const afterRequired = new Set(newFlat.required ?? []);
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const name of [...names].sort()) {
    const propLoc = descend(loc, name, ['properties', name]);
    const inOld = Object.hasOwn(before, name);
    const inNew = Object.hasOwn(after, name);

    if (!inOld && inNew) {
      const required = afterRequired.has(name);
      ctx.add(
        required ? 'schema.property.added.required' : 'schema.property.added',
        propLoc,
        `${where(propLoc)} added${required ? ' as required' : ''}`,
      );
      continue;
    }
    if (inOld && !inNew) {
      ctx.add('schema.property.removed', propLoc, `${where(propLoc)} removed`);
      continue;
    }

    if (beforeRequired.has(name) !== afterRequired.has(name)) {
      const nowRequired = afterRequired.has(name);
      ctx.add(
        nowRequired ? 'schema.required.added' : 'schema.required.removed',
        propLoc,
        `${where(propLoc)} became ${nowRequired ? 'required' : 'optional'}`,
      );
    }

    diffSchema(before[name], after[name], ctx, propLoc, state);
  }

  // A `required` entry naming a property that is not declared is still part of
  // the contract; catch those so nothing silently disappears.
  for (const name of [...afterRequired].sort()) {
    if (!names.has(name) && !beforeRequired.has(name)) {
      ctx.add(
        'schema.required.added',
        { ...loc, pointer: pointerJoin(loc.pointer, 'required') },
        `${where(loc)} now requires undeclared member "${name}"`,
      );
    }
  }
  for (const name of [...beforeRequired].sort()) {
    if (!names.has(name) && !afterRequired.has(name)) {
      ctx.add(
        'schema.required.removed',
        { ...loc, pointer: pointerJoin(loc.pointer, 'required') },
        `${where(loc)} no longer requires undeclared member "${name}"`,
      );
    }
  }
}
