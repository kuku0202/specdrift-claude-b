import { pointerJoin, type RefResolver } from '../refs.js';
import type {
  Direction,
  MediaType,
  Operation,
  Parameter,
  PathItem,
  Response,
  SecurityRequirement,
} from '../types.js';

import type { DiffContext, Loc } from './context.js';
import { diffSchema, type SchemaLoc } from './schema.js';
import { diffSecurity } from './security.js';

/** A parameter's identity is the pair (name, location), per the OpenAPI spec. */
function parameterKey(parameter: Parameter): string {
  return `${parameter.in ?? 'query'} ${parameter.name ?? ''}`;
}

/**
 * The parameters that actually apply to an operation.
 *
 * Path-level parameters apply to every operation on the path, and an
 * operation-level parameter with the same (name, in) replaces rather than
 * supplements the inherited one.
 */
export function effectiveParameters(
  pathItem: PathItem | undefined,
  operation: Operation | undefined,
  refs: RefResolver,
): Map<string, Parameter> {
  const result = new Map<string, Parameter>();
  for (const list of [pathItem?.parameters, operation?.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object') continue;
      const parameter = refs.resolve(raw).value;
      if (typeof parameter.name !== 'string') continue;
      result.set(parameterKey(parameter), parameter);
    }
  }
  return result;
}

/** The security requirements in force for an operation. */
export function effectiveSecurity(
  operation: Operation | undefined,
  documentSecurity: SecurityRequirement[] | undefined,
): SecurityRequirement[] {
  const own = operation?.security;
  if (Array.isArray(own)) return own;
  return Array.isArray(documentSecurity) ? documentSecurity : [];
}

/** True for status codes that denote success. `default` is treated as an error. */
export function isSuccessStatus(code: string): boolean {
  return /^2\d\d$/.test(code) || /^2xx$/i.test(code);
}

/** Compare two operations on the same path and method. */
export function diffOperation(
  oldPathItem: PathItem | undefined,
  newPathItem: PathItem | undefined,
  oldOperation: Operation,
  newOperation: Operation,
  ctx: DiffContext,
  loc: Loc,
): void {
  diffMetadata(oldOperation, newOperation, ctx, loc);
  diffParameters(oldPathItem, newPathItem, oldOperation, newOperation, ctx, loc);
  diffRequestBody(oldOperation, newOperation, ctx, loc);
  diffResponses(oldOperation, newOperation, ctx, loc);
  diffSecurity(
    effectiveSecurity(oldOperation, ctx.oldDocument.security),
    effectiveSecurity(newOperation, ctx.newDocument.security),
    ctx,
    loc,
  );
}

function diffMetadata(
  oldOperation: Operation,
  newOperation: Operation,
  ctx: DiffContext,
  loc: Loc,
): void {
  const before = oldOperation.operationId;
  const after = newOperation.operationId;
  if (typeof before === 'string' && typeof after === 'string' && before !== after) {
    ctx.add(
      'operationId.changed',
      { ...loc, pointer: pointerJoin(loc.pointer, 'operationId') },
      'operationId changed',
      { from: before, to: after },
    );
  }
  if (oldOperation.deprecated !== true && newOperation.deprecated === true) {
    ctx.add(
      'operation.deprecated',
      { ...loc, pointer: pointerJoin(loc.pointer, 'deprecated') },
      'the operation is now deprecated',
    );
  }
}

function diffParameters(
  oldPathItem: PathItem | undefined,
  newPathItem: PathItem | undefined,
  oldOperation: Operation,
  newOperation: Operation,
  ctx: DiffContext,
  loc: Loc,
): void {
  const before = effectiveParameters(oldPathItem, oldOperation, ctx.oldRefs);
  const after = effectiveParameters(newPathItem, newOperation, ctx.newRefs);
  const keys = new Set([...before.keys(), ...after.keys()]);

  for (const key of [...keys].sort()) {
    const oldParameter = before.get(key);
    const newParameter = after.get(key);
    const name = (newParameter ?? oldParameter)?.name ?? '';
    const location = (newParameter ?? oldParameter)?.in ?? 'query';
    const paramLoc: SchemaLoc = {
      ...loc,
      direction: 'request',
      subject: `${location} parameter "${name}"`,
      pointer: pointerJoin(loc.pointer, 'parameters', `${location}/${name}`),
    };

    if (!oldParameter && newParameter) {
      const required = newParameter.required === true;
      ctx.add(
        required ? 'parameter.added.required' : 'parameter.added.optional',
        paramLoc,
        `${required ? 'required' : 'optional'} ${location} parameter "${name}" added`,
      );
      continue;
    }
    if (oldParameter && !newParameter) {
      ctx.add(
        'parameter.removed',
        paramLoc,
        `${location} parameter "${name}" removed`,
      );
      continue;
    }
    if (!oldParameter || !newParameter) continue;

    const wasRequired = oldParameter.required === true;
    const isRequired = newParameter.required === true;
    if (wasRequired !== isRequired) {
      ctx.add(
        isRequired ? 'parameter.required.added' : 'parameter.required.removed',
        paramLoc,
        `${location} parameter "${name}" became ${isRequired ? 'required' : 'optional'}`,
      );
    }
    if (oldParameter.deprecated !== true && newParameter.deprecated === true) {
      ctx.add(
        'parameter.deprecated',
        paramLoc,
        `${location} parameter "${name}" is now deprecated`,
      );
    }

    diffSchema(oldParameter.schema, newParameter.schema, ctx, paramLoc);
    diffContent(oldParameter.content, newParameter.content, ctx, paramLoc, 'parameter');
  }
}

function diffRequestBody(
  oldOperation: Operation,
  newOperation: Operation,
  ctx: DiffContext,
  loc: Loc,
): void {
  const before = oldOperation.requestBody
    ? ctx.oldRefs.resolve(oldOperation.requestBody).value
    : undefined;
  const after = newOperation.requestBody
    ? ctx.newRefs.resolve(newOperation.requestBody).value
    : undefined;
  const bodyLoc: SchemaLoc = {
    ...loc,
    direction: 'request',
    subject: 'the request body',
    pointer: pointerJoin(loc.pointer, 'requestBody'),
  };

  if (!before && !after) return;
  if (!before && after) {
    const required = after.required === true;
    ctx.add(
      required ? 'requestBody.added.required' : 'requestBody.added.optional',
      bodyLoc,
      `a ${required ? 'required' : 'optional'} request body was added`,
    );
    return;
  }
  if (before && !after) {
    ctx.add('requestBody.removed', bodyLoc, 'the request body was removed');
    return;
  }
  if (!before || !after) return;

  const wasRequired = before.required === true;
  const isRequired = after.required === true;
  if (wasRequired !== isRequired) {
    ctx.add(
      isRequired ? 'requestBody.required.added' : 'requestBody.required.removed',
      bodyLoc,
      `the request body became ${isRequired ? 'required' : 'optional'}`,
    );
  }

  diffContent(before.content, after.content, ctx, bodyLoc, 'requestBody');
}

function diffResponses(
  oldOperation: Operation,
  newOperation: Operation,
  ctx: DiffContext,
  loc: Loc,
): void {
  const before = oldOperation.responses ?? {};
  const after = newOperation.responses ?? {};
  const codes = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const code of [...codes].sort()) {
    const responseLoc: SchemaLoc = {
      ...loc,
      direction: 'response',
      subject: `response ${code}`,
      pointer: pointerJoin(loc.pointer, 'responses', code),
    };
    const success = isSuccessStatus(code);
    const oldRaw = before[code];
    const newRaw = after[code];

    if (!oldRaw && newRaw) {
      ctx.add(
        success ? 'response.success.added' : 'response.error.added',
        responseLoc,
        `response ${code} added`,
      );
      continue;
    }
    if (oldRaw && !newRaw) {
      ctx.add(
        success ? 'response.success.removed' : 'response.error.removed',
        responseLoc,
        `response ${code} removed`,
      );
      continue;
    }
    if (!oldRaw || !newRaw) continue;

    const oldResponse: Response = ctx.oldRefs.resolve(oldRaw).value;
    const newResponse: Response = ctx.newRefs.resolve(newRaw).value;
    diffResponseHeaders(oldResponse, newResponse, ctx, responseLoc);
    diffContent(oldResponse.content, newResponse.content, ctx, responseLoc, 'response');
  }
}

function diffResponseHeaders(
  oldResponse: Response,
  newResponse: Response,
  ctx: DiffContext,
  loc: SchemaLoc,
): void {
  const before = oldResponse.headers ?? {};
  const after = newResponse.headers ?? {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const name of [...names].sort()) {
    const headerLoc: SchemaLoc = {
      ...loc,
      subject: `${loc.subject} header "${name}"`,
      pointer: pointerJoin(loc.pointer, 'headers', name),
    };
    const inOld = Object.hasOwn(before, name);
    const inNew = Object.hasOwn(after, name);
    if (!inOld && inNew) {
      ctx.add('response.header.added', headerLoc, `${loc.subject} gained header "${name}"`);
      continue;
    }
    if (inOld && !inNew) {
      ctx.add('response.header.removed', headerLoc, `${loc.subject} lost header "${name}"`);
      continue;
    }
    const oldHeader = ctx.oldRefs.resolve(before[name] as Parameter).value;
    const newHeader = ctx.newRefs.resolve(after[name] as Parameter).value;
    diffSchema(oldHeader?.schema, newHeader?.schema, ctx, headerLoc);
  }
}

/** Compare the media types of a request body, response, or parameter content. */
function diffContent(
  before: Record<string, MediaType | undefined> | undefined,
  after: Record<string, MediaType | undefined> | undefined,
  ctx: DiffContext,
  loc: SchemaLoc,
  owner: 'requestBody' | 'response' | 'parameter',
): void {
  const oldContent = before ?? {};
  const newContent = after ?? {};
  const types = new Set([...Object.keys(oldContent), ...Object.keys(newContent)]);
  const direction: Direction = owner === 'response' ? 'response' : 'request';

  for (const mediaType of [...types].sort()) {
    const mediaLoc: SchemaLoc = {
      ...loc,
      direction,
      // Naming the media type on every line is noise when there is only one, and
      // JSON is overwhelmingly the one.
      subject:
        mediaType === 'application/json' ? loc.subject : `${loc.subject} (${mediaType})`,
      pointer: pointerJoin(loc.pointer, 'content', mediaType),
    };
    const inOld = Object.hasOwn(oldContent, mediaType);
    const inNew = Object.hasOwn(newContent, mediaType);

    if (!inOld && inNew) {
      ctx.add(
        direction === 'response' ? 'response.mediaType.added' : 'requestBody.mediaType.added',
        mediaLoc,
        `${loc.subject} gained media type "${mediaType}"`,
      );
      continue;
    }
    if (inOld && !inNew) {
      ctx.add(
        direction === 'response'
          ? 'response.mediaType.removed'
          : 'requestBody.mediaType.removed',
        mediaLoc,
        `${loc.subject} lost media type "${mediaType}"`,
      );
      continue;
    }
    diffSchema(oldContent[mediaType]?.schema, newContent[mediaType]?.schema, ctx, mediaLoc);
  }
}
