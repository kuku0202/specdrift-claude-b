# specdrift

Diff two OpenAPI 3.x specifications and report what changed — with the changes that
will break your callers separated from the ones that will not.

```console
$ specdrift ./v1.yaml ./v2.yaml
```

`specdrift` exits `0` when nothing breaking was found and `1` when something was, so it
drops straight into a CI job as a gate on API compatibility.

[![npm](https://img.shields.io/npm/v/%40yuesu4%2Fspecdrift-claude-b.svg)](https://www.npmjs.com/package/@yuesu4/specdrift-claude-b)

---

## Install

```bash
npm install --global @yuesu4/specdrift-claude-b
```

Or run it without installing:

```bash
npx @yuesu4/specdrift-claude-b old.yaml new.yaml
```

Requires Node.js 20.11 or newer.

## Usage

```
specdrift <old-spec> <new-spec> [options]
```

Each argument may be a **local file path** or an **`http(s)` URL**, in either **JSON or
YAML**. Remote documents are cached on disk (see [Caching](#caching)).

| Option | Description |
| --- | --- |
| `-f, --format <text\|json>` | Output format. Default `text`. |
| `--fail-on <severity>` | Exit non-zero when a change of this severity **or worse** is found: `breaking`, `warning`, `additive`, `informational`, or `none`. Default `breaking`. |
| `--limit <n>` | Show at most *n* changes per severity group. The summary still counts every change. |
| `--no-cache` | Neither read nor write the on-disk cache of fetched specs. |
| `--cache-dir <path>` | Override the cache directory. |
| `--color` / `--no-color` | Force colour on or off. Default: on when stdout is a TTY. |
| `--rules` | Print the severity taxonomy and exit. |
| `--clear-cache` | Delete the cache directory and exit. |
| `-h, --help` | Show help. |
| `-V, --version` | Print the version. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No change met the `--fail-on` threshold. |
| `1` | At least one change met the threshold. |
| `2` | Bad usage, or a specification could not be read or parsed. |

Errors get their own code so a CI job can tell "the API broke" apart from "the spec URL
404'd" — the two want very different responses.

### In CI

```yaml
- name: Check API compatibility
  run: npx @yuesu4/specdrift-claude-b
        https://api.example.com/openapi.json
        ./openapi.json
```

The step fails only on breaking changes. To be stricter, add `--fail-on warning`.

---

## The severity taxonomy

Every change specdrift finds is classified into one of four severities. The
classification is not a vague sense of risk; it follows from one question:

> **Does this change invalidate something an existing, conforming consumer was already
> doing?**

| Severity | Meaning |
| --- | --- |
| **breaking** | An existing conforming consumer stops working. Requires a major version bump. |
| **warning** | May break some consumers depending on how they use the API. specdrift cannot prove it safe. |
| **additive** | Extends the contract without invalidating anything a conforming consumer did before. |
| **informational** | No effect on the contract at all. |

### Why direction matters

The single most important idea in the table below is that **a request and a response
break in opposite directions.**

An API description is a two-way agreement. The request half describes what the server
promises to *accept*; the response half describes what it promises to *return*. Those
promises are consumed from opposite ends:

- **Requests are contravariant.** Narrowing what the server accepts breaks callers.
  Widening it is always safe. Adding a required field, removing an enum value, or
  tightening a maximum all reject traffic that used to succeed.
- **Responses are covariant.** Narrowing what the server returns breaks readers.
  Widening it is *mostly* safe. Removing a field, making a field nullable, or dropping a
  guarantee all invalidate code that was written against the old shape.

So the same edit lands on opposite ends of the scale depending on which half of the
document it appears in:

| Edit | In a request | In a response |
| --- | --- | --- |
| A field becomes required | **breaking** — old bodies are now rejected | **additive** — a stronger guarantee |
| A field stops being required | **additive** — more bodies accepted | **breaking** — a guarantee withdrawn |
| A field becomes nullable | **additive** — `null` is now accepted too | **breaking** — the classic null-dereference |
| An enum gains a value | **additive** — one more input accepted | **warning** — a closed client type may not parse it |
| An enum loses a value | **breaking** — callers sending it are rejected | **additive** — one fewer case to handle |

Any tool that classifies changes without tracking this distinction has to pick one
answer for both, and will be wrong half the time. specdrift carries a `direction` on
every schema change and rules accordingly; it is reported in the JSON output.

### Judgement calls, and why

A few rulings are worth defending explicitly, because reasonable people put them
elsewhere:

**Removing a request parameter is a `warning`, not `additive`.** The tempting reading is
that the server just ignores it now, which harms nobody. But there are two possible
behaviours and the document does not say which: a server with strict validation returns
`400`, and a lenient one accepts the request and *silently discards* a value the caller
believed was meaningful. The silent case is the more dangerous of the two, precisely
because nothing fails. Neither outcome is provably safe, so it is a warning.

**Adding a *success* status code is a `warning`; adding an *error* code is `additive`.**
Clients handle unexpected errors generically — they already have a path for "something
went wrong". Success is different: an enormous amount of real client code tests
`status === 200` rather than `2xx`, so a `201` appearing on an endpoint that only ever
returned `200` silently routes responses into the error branch.

**Removing a *success* code is `breaking`; removing an *error* code is a `warning`.** A
success the client was written against is simply gone. A removed error code is subtler:
the client's handling for it is now dead, and whatever condition used to produce it may
now surface as a *different* code.

**Changing `operationId` is a `warning`,** even though it alters no wire behaviour at
all. `operationId` is what almost every client generator uses to name the generated
method. Renaming it does not break the HTTP contract; it breaks the *compile* of every
regenerated SDK downstream.

**Deprecation is `informational`.** Marking an operation deprecated announces a future
removal. It does not change a single byte of behaviour today. Failing a build on it
would mean a team could not deprecate its own endpoint without breaking its own CI.

**Security is a list of alternatives, not a list of requirements.** OpenAPI's `security`
field is an OR of AND-sets: `[{apiKey: []}, {oauth2: [read]}]` means *either* an API key
*or* an OAuth token with `read`. This makes two superficially similar edits land on
opposite ends of the scale:

- Adding a new *alternative* (`security: [{a}]` → `[{a}, {b}]`) is **additive** — one
  more way to authenticate.
- Adding a scheme *inside* an existing alternative (`[{a}]` → `[{a, b}]`) is
  **breaking** — every caller must now present an additional credential.

specdrift pairs alternatives across the two documents by how many scheme names they
share, so the second case is reported as one alternative that gained a scheme rather
than as an unrelated removal and addition. An empty requirement object `{}` means
anonymous access is permitted; withdrawing it is `security.made.required`, and it is
breaking.

**`format` changes are a `warning` in both directions.** `format` narrows a type without
changing it — `int32` → `int64`, `date` → `date-time`. Whether that breaks anything
depends entirely on the parser at the other end, which the document does not describe.
specdrift will not guess.

### The full table

Generated from the rule table in [`src/severity.ts`](src/severity.ts) — `specdrift --rules`
prints the same thing. A test asserts this section matches the code, so it cannot drift.

<!-- BEGIN GENERATED TAXONOMY -->

#### Endpoints and operations

| Change | Severity | Reasoning |
| --- | --- | --- |
| `endpoint.added` | additive | New surface area. No existing call changes behaviour. |
| `endpoint.removed` | breaking | Every existing call to the path now fails. |
| `operation.added` | additive | A new method on an existing path leaves other methods untouched. |
| `operation.removed` | breaking | Callers using this method now receive 404 or 405. |
| `operation.deprecated` | informational | Deprecation announces a future removal; it does not itself change behaviour. |
| `operationId.changed` | warning | operationId names the generated method in most client generators, so renaming it renames a public method in every regenerated SDK. |

#### Request parameters

| Change | Severity | Reasoning |
| --- | --- | --- |
| `parameter.added.required` | breaking | Existing requests omit the parameter and will be rejected. |
| `parameter.added.optional` | additive | Requests that ignore the new parameter are still valid. |
| `parameter.removed` | warning | The server may reject the now-undeclared parameter, or silently ignore it — and silently dropping a caller-supplied value is the more dangerous of the two. |
| `parameter.required.added` | breaking | Requests that previously omitted the parameter are now invalid. |
| `parameter.required.removed` | additive | The server accepts strictly more requests than before. |
| `parameter.deprecated` | informational | An announcement about a future removal, not a behaviour change. |

#### Request bodies

| Change | Severity | Reasoning |
| --- | --- | --- |
| `requestBody.added.required` | breaking | Existing requests send no body and will be rejected. |
| `requestBody.added.optional` | additive | Requests without a body remain valid. |
| `requestBody.removed` | warning | The body a caller still sends is now undeclared: it may be rejected, or accepted and ignored. |
| `requestBody.required.added` | breaking | A body that was optional is now mandatory. |
| `requestBody.required.removed` | additive | The server accepts strictly more requests than before. |
| `requestBody.mediaType.added` | additive | An additional way to encode the same request. |
| `requestBody.mediaType.removed` | breaking | Callers sending this Content-Type now receive 415 Unsupported Media Type. |

#### Responses

| Change | Severity | Reasoning |
| --- | --- | --- |
| `response.success.added` | warning | Clients that test for an exact success code (status === 200) rather than a range will not recognise the new one. |
| `response.error.added` | additive | A newly documented failure mode. Generic error handling already covers it. |
| `response.success.removed` | breaking | The success status the client was written against is no longer returned. |
| `response.error.removed` | warning | The error contract narrowed: handling for this code is now dead, and the underlying condition may surface as a different code. |
| `response.mediaType.added` | additive | An additional representation the client may opt into. |
| `response.mediaType.removed` | breaking | Clients requesting this Content-Type can no longer be served. |
| `response.header.added` | additive | Clients ignore headers they do not read. |
| `response.header.removed` | breaking | A header the client may depend on is no longer sent. |

#### Schemas

| Change | Severity | Reasoning |
| --- | --- | --- |
| `schema.property.added` | additive | On a request the server accepts more; on a response clients ignore fields they do not read. |
| `schema.property.added.required` | in a request **breaking**<br>in a response **additive** | A new mandatory input invalidates every existing request body. In a response it is simply one more guaranteed field. |
| `schema.property.removed` | in a request **warning**<br>in a response **breaking** | A request property may be rejected as unknown or silently dropped; a response property the client reads is simply gone. |
| `schema.type.changed` | breaking | A value of the old type is not a value of the new one, in either direction. |
| `schema.format.changed` | warning | format narrows a type without changing it (int32 to int64, date to date-time). Whether it breaks depends on the parser at the other end, so specdrift cannot prove it safe. |
| `schema.required.added` | in a request **breaking**<br>in a response **additive** | A newly required field invalidates existing request bodies, but strengthens a response guarantee. |
| `schema.required.removed` | in a request **additive**<br>in a response **breaking** | Dropping a requirement widens what a request may look like, but withdraws a guarantee the client relied on when reading a response. |
| `schema.enum.value.added` | in a request **additive**<br>in a response **warning** | The server accepts one more input value; but a client parsing a response into a closed type (an enum, a sealed class, an exhaustive switch) will fail on a value it has never seen. |
| `schema.enum.value.removed` | in a request **breaking**<br>in a response **additive** | A value callers are sending is no longer accepted. In a response, one fewer case to handle. |
| `schema.nullable.added` | in a request **additive**<br>in a response **breaking** | Accepting null widens the input. Returning null where the client never expected one is the classic null-dereference break. |
| `schema.nullable.removed` | in a request **breaking**<br>in a response **additive** | Callers sending null are now rejected; readers get a stronger guarantee. |
| `schema.additionalProperties.restricted` | in a request **breaking**<br>in a response **additive** | Extra members a caller was sending are now rejected. |
| `schema.additionalProperties.allowed` | in a request **additive**<br>in a response **informational** | The server tolerates more input. On a response it only means undeclared members may appear, which clients already ignore. |
| `schema.constraint.tightened` | in a request **breaking**<br>in a response **warning** | Values a caller was sending now fall outside the accepted range. On a response, a narrower range is safe for most clients but changes what is documented. |
| `schema.constraint.relaxed` | in a request **additive**<br>in a response **warning** | The server accepts more. On a response, values may now exceed the size the client allocated for them. |
| `schema.composition.changed` | warning | allOf/oneOf/anyOf was restructured. Compatibility depends on the branches, which specdrift reports rather than attempts to prove. |

#### Security

| Change | Severity | Reasoning |
| --- | --- | --- |
| `security.alternative.added` | additive | OpenAPI security is a list of alternatives; one more alternative is one more way to authenticate. |
| `security.alternative.removed` | breaking | Callers authenticating this way are locked out. |
| `security.scheme.added` | breaking | Schemes within one alternative are combined with AND, so an extra scheme is an extra credential every caller must now present. |
| `security.scheme.removed` | additive | One fewer credential is required. |
| `security.scopes.added` | breaking | Tokens issued without the new scope are rejected. |
| `security.scopes.removed` | additive | The operation demands less of the token than before. |
| `security.made.required` | breaking | Anonymous access was withdrawn. |
| `security.made.optional` | additive | The operation may now be called without credentials. |

<!-- END GENERATED TAXONOMY -->

---

## Worked example: two released versions of the GitHub REST API

This is a real run against two published releases of
[github/rest-api-description](https://github.com/github/rest-api-description), fetched
over HTTPS — about 4 MB of JSON on each side. It completes in well under a second.

```bash
BASE=https://raw.githubusercontent.com/github/rest-api-description
specdrift \
  "$BASE/v1.1.4/descriptions/api.github.com/api.github.com.json" \
  "$BASE/v2.0.0/descriptions/api.github.com/api.github.com.json" \
  --limit 6
```

```text
GitHub v3 REST API  1.1.4 -> 1.1.4
https://raw.githubusercontent.com/github/rest-api-description/v1.1.4/descriptions/api.github.com/api.github.com.json -> https://raw.githubusercontent.com/github/rest-api-description/v2.0.0/descriptions/api.github.com/api.github.com.json

BREAKING (82)
  PATCH /app/hook/config
    x the request body became required [requestBody.required.added]
  /applications/grants
    x path /applications/grants removed [endpoint.removed]
  /applications/grants/{grant_id}
    x path /applications/grants/{grant_id} removed [endpoint.removed]
  /authorizations
    x path /authorizations removed [endpoint.removed]
  /authorizations/{authorization_id}
    x path /authorizations/{authorization_id} removed [endpoint.removed]
  /authorizations/clients/{client_id}
    x path /authorizations/clients/{client_id} removed [endpoint.removed]
    ... and 76 more (raise --limit to show them)

WARNING (63)
  POST /app-manifests/{code}/conversions
    ! the request body was removed [requestBody.removed]
  GET /app/installations/{installation_id}
    ! response 415 removed [response.error.removed]
  POST /app/installations/{installation_id}/access_tokens
    ! response 415 removed [response.error.removed]
  GET /apps/{app_slug}
    ! response 415 removed [response.error.removed]
  GET /orgs/{org}/blocks
    ! response 415 removed [response.error.removed]
  GET /orgs/{org}/members
    ! response 302 removed [response.error.removed]
    ... and 57 more (raise --limit to show them)

ADDITIVE (2162)
  GET /app/installations
    + response 200 property "[].permissions.organization_custom_roles" added [schema.property.added]
  GET /app/installations/{installation_id}
    + response 200 property "permissions.organization_custom_roles" added [schema.property.added]
  POST /app/installations/{installation_id}/access_tokens
    + the request body property "permissions.organization_custom_roles" added [schema.property.added]
    + response 201 property "permissions.organization_custom_roles" added [schema.property.added]
    + response 201 property "repositories[].allow_update_branch" added [schema.property.added]
    + response 201 property "repositories[].anonymous_access_enabled" added [schema.property.added]
    ... and 2156 more (raise --limit to show them)

2307 changes: 82 breaking | 63 warning | 2162 additive
```

Three things in that output are worth pointing at.

**The headline breakage is real and recognisable.** `/authorizations` and
`/applications/grants` are the OAuth Authorizations API, which GitHub removed outright
between these releases. specdrift finds all of it, and does not bury it among the 2,162
additive changes.

**The nested paths came out of `$ref`s.** `permissions.organization_custom_roles` is not
written anywhere in the path item — the response schema is a `$ref` to
`#/components/schemas/installation`, whose `permissions` member is another `$ref` to
`app-permissions`, which is where the new property was added. specdrift resolves
references, follows them into components, and reports the dotted path a client developer
would actually recognise. `repositories[].allow_update_branch` shows the same thing
through an array.

**The two documents both declare `info.version: 1.1.4`,** even though one is tagged
`v1.1.4` and the other `v2.0.0`. GitHub's version string simply lags their release tags.
This is a good argument for diffing the document rather than trusting the number in it.

> Every claim above was spot-checked against the raw JSON: `/authorizations` present in
> v1.1.4 and absent in v2.0.0; `PATCH /app/hook/config` `requestBody.required` `false` →
> `true`; `GET /apps/{app_slug}` losing its `415`; and `organization_custom_roles`
> appearing in the `app-permissions` schema. The test suite asserts the first of these
> against the live URLs on every run.

---

## JSON output

`--format json` emits a stable, deterministic document — no timestamps, no absolute
paths beyond the inputs you passed — so it can be committed as a fixture or compared
between runs.

```console
$ specdrift old.yaml new.yaml --format json
```

```json
{
  "formatVersion": 1,
  "specdriftVersion": "0.1.0",
  "source": {
    "old": { "input": "old.yaml", "kind": "file", "title": "Widgets API", "version": "1.0.0" },
    "new": { "input": "new.yaml", "kind": "file", "title": "Widgets API", "version": "2.0.0" }
  },
  "summary": {
    "total": 11,
    "bySeverity": { "breaking": 4, "warning": 3, "additive": 4, "informational": 0 },
    "highestSeverity": "breaking"
  },
  "changes": [
    {
      "kind": "schema.nullable.added",
      "severity": "breaking",
      "area": "schema",
      "message": "response 200 property \"id\" became nullable",
      "pointer": "/paths/~1widgets~1{id}/get/responses/200/content/application~1json/properties/id",
      "direction": "response",
      "path": "/widgets/{id}",
      "method": "get",
      "operationId": "getWidget"
    }
  ]
}
```

`formatVersion` is bumped only for a breaking change to this structure, so a consumer can
pin against it. `pointer` is an [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON
Pointer into the document that best describes the change: the old document for removals,
the new one otherwise.

---

## Caching

Fetched specifications are cached on disk so repeat runs do not re-download. The cache
directory is `$SPECDRIFT_CACHE_DIR`, else `$XDG_CACHE_HOME/specdrift`, else
`~/.cache/specdrift`.

An entry younger than 24 hours is served directly. An older one is **revalidated** with
`If-None-Match` / `If-Modified-Since`, so an unchanged spec costs one `304` rather than a
full redownload. If the network is unreachable and a cached copy exists, specdrift uses
the stale copy rather than failing.

- `--no-cache` bypasses the cache entirely, neither reading nor writing.
- `--clear-cache` deletes the directory.

Cache failures are never fatal: a read-only or full disk degrades to an uncached run.

---

## Programmatic API

specdrift ships type declarations and is usable as a library.

```ts
import { diffSpecs, meetsThreshold, renderText } from '@yuesu4/specdrift-claude-b';

const result = await diffSpecs('./v1.yaml', 'https://example.com/v2.yaml');

console.log(renderText(result, { color: false }));

const breaking = result.changes.filter((c) => meetsThreshold(c.severity, 'breaking'));
if (breaking.length > 0) process.exitCode = 1;
```

### Public surface

**Diffing**

| Export | Description |
| --- | --- |
| `diffSpecs(oldInput, newInput, options?)` | Load two specs (path or URL) and diff them. Returns `Promise<DiffResult>`. |
| `diffDocuments(oldDoc, newDoc, sources, options?)` | Diff two already-parsed documents. Synchronous. |
| `diffSchema`, `diffSecurity` | The individual differs, for building on. |
| `sortChanges(changes)` | Sort by severity then location, as the report does. |

**Loading**

| Export | Description |
| --- | --- |
| `loadSpec(input, options?)` | Read and parse one spec from a path or URL. Returns `{ document, source }`. |
| `parseSpec(text, input?)` | Parse JSON or YAML text into a document. |
| `isUrl(input)` | Whether an input will be treated as a URL. |
| `SpecLoadError` | Thrown for unreadable or unparseable input. |

**Reporting**

| Export | Description |
| --- | --- |
| `renderText(result, { color?, limit? })` | The human-readable report. |
| `renderJson(result, indent?)` | The machine-readable report. |
| `renderRulesMarkdown()` / `renderRulesText()` | The taxonomy table. |

**Severity**

| Export | Description |
| --- | --- |
| `RULES` | The complete rule table: every change kind, its severity, and its rationale. |
| `severityFor(kind, direction?)` | Resolve a kind's severity. |
| `rationaleFor(kind)` | The documented reasoning for a kind. |
| `meetsThreshold(severity, threshold)` | Whether a severity should trip a `--fail-on` threshold. |
| `maxSeverity(severities)` / `severityRank(severity)` | Ordering helpers. |
| `CHANGE_KINDS` | Every kind specdrift can emit. |

**Caching**

`cacheDir()`, `cacheStats()`, `clearCache()`, `DEFAULT_TTL_MS`.

**Types**

`DiffResult`, `Change`, `Severity`, `Direction`, `ChangeArea`, `ChangeKind`, `SpecSource`,
`DiffOptions`, `LoadOptions`, `OpenApiDocument`, and the OpenAPI node types.

### `DiffOptions`

| Option | Default | Description |
| --- | --- | --- |
| `maxDepth` | `24` | How deep to follow nested schemas. Recursive `$ref` cycles are detected separately and are not subject to this limit. |

### `LoadOptions`

| Option | Default | Description |
| --- | --- | --- |
| `noCache` | `false` | Bypass the disk cache. |
| `cacheDir` | platform default | Override the cache directory. |
| `ttlMs` | 24 h | How long a cached document is served without revalidating. |
| `timeoutMs` | `30000` | Request timeout. |
| `fetchImpl` | global `fetch` | Injectable, for tests. |

---

## What specdrift understands

- Paths added, removed, and methods added or removed on a surviving path.
- Parameters — added, removed, and moving between required and optional — including
  path-level parameters inherited by every operation, and operation-level parameters that
  override them. A parameter's identity is the pair `(name, in)`, per the specification.
- Request bodies: presence, requiredness, media types, and their schemas.
- Responses: status codes, media types, headers, and their schemas.
- Schemas, recursively: types, formats, nullability, `enum` values, `required`,
  properties, array `items`, `additionalProperties`, numeric and string constraints, and
  `oneOf`/`anyOf`/`allOf` composition.
- Security requirements, with alternatives, schemes, and scopes handled per OpenAPI's
  OR-of-ANDs semantics.

Some deliberate design decisions:

- **`$ref`s are resolved,** including chains, and including a Path Item that is itself a
  reference. Recursive schemas — a `Node` whose `children` are `Node`s — terminate
  correctly through cycle detection rather than a depth cut-off.
- **`allOf` is flattened** into the shape a client actually sees, so reordering
  inheritance branches produces no output. Branches carrying `oneOf`/`anyOf` cannot be
  merged and are reported as composition changes instead.
- **OpenAPI 3.0 and 3.1 nullability are treated as equivalent.** `type: string` with
  `nullable: true` and `type: [string, "null"]` describe the same contract, and migrating
  between the two spellings produces no output.
- **Output is deterministic.** Changes are sorted by severity, then path, method, pointer
  and kind. Two runs over the same inputs produce identical bytes.

### Limitations

- External `$ref`s (into another file or URL) are not followed; they are compared as
  reference strings. Bundled single-document specs — what real APIs publish — are fully
  supported.
- Swagger 2.0 is rejected with a message telling you to convert first.
- `oneOf`/`anyOf` branches are matched positionally when the branch count is unchanged.
  There is no identity to match on in the document, so a reordering is reported as a
  change.
- `webhooks` and `callbacks` are not yet diffed.

---

## Development

```bash
npm install
npm run build       # compile to dist/ with declarations
npm run typecheck
npm run lint
npm test            # builds first, then runs vitest
npm run docs:rules  # regenerate the taxonomy table in this README
npm run docs:site   # build the documentation site into site/
```

The test suite includes fixture pairs for each change category under
[`test/fixtures/`](test/fixtures), unit tests for the schema differ's harder cases
(recursion, `allOf`, 3.0-vs-3.1 nullability), CLI tests covering every flag and exit
code, and live tests that fetch real specifications over HTTPS. Set
`SPECDRIFT_SKIP_LIVE=1` to skip the networked tests when working offline.

## License

MIT
