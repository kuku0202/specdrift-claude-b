import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The subset of `process.env` this module reads.
 *
 * Spelled structurally rather than as `NodeJS.ProcessEnv` so the published type
 * declarations do not oblige a consumer to have `@types/node` installed.
 */
export type EnvLike = Record<string, string | undefined>;

/** How long a cached document is served without revalidating, in ms. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Metadata stored alongside a cached document body. */
export interface CacheMeta {
  url: string;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  /** Epoch milliseconds at which the body was last confirmed fresh. */
  fetchedAt: number;
}

export interface CacheEntry {
  body: string;
  meta: CacheMeta;
  /** True when the entry is older than the TTL and should be revalidated. */
  stale: boolean;
}

/**
 * Directory holding cached specifications.
 *
 * Honours `SPECDRIFT_CACHE_DIR`, then `XDG_CACHE_HOME`, then `~/.cache`. Falls
 * back to the system temp directory when there is no usable home directory
 * (some CI containers).
 */
export function cacheDir(env: EnvLike = process.env): string {
  const explicit = env['SPECDRIFT_CACHE_DIR'];
  if (explicit) return explicit;
  const xdg = env['XDG_CACHE_HOME'];
  if (xdg) return join(xdg, 'specdrift');
  try {
    const home = homedir();
    if (home) return join(home, '.cache', 'specdrift');
  } catch {
    /* fall through */
  }
  return join(tmpdir(), 'specdrift-cache');
}

function keyFor(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

/** Read a cached document, or `null` when the URL has not been cached. */
export async function readCache(
  url: string,
  options: { ttlMs?: number; dir?: string } = {},
): Promise<CacheEntry | null> {
  const dir = options.dir ?? cacheDir();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const key = keyFor(url);
  try {
    const [body, rawMeta] = await Promise.all([
      readFile(join(dir, `${key}.body`), 'utf8'),
      readFile(join(dir, `${key}.json`), 'utf8'),
    ]);
    const meta = JSON.parse(rawMeta) as CacheMeta;
    // `>=` so that a ttl of 0 means "always revalidate", rather than
    // depending on whether the clock happened to tick.
    return { body, meta, stale: Date.now() - meta.fetchedAt >= ttlMs };
  } catch {
    // A missing, unreadable or corrupt entry is a cache miss, never an error.
    return null;
  }
}

/** Store a document body and its metadata. Cache failures are non-fatal. */
export async function writeCache(
  meta: CacheMeta,
  body: string,
  options: { dir?: string } = {},
): Promise<void> {
  const dir = options.dir ?? cacheDir();
  const key = keyFor(meta.url);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}.body`), body, 'utf8');
    await writeFile(join(dir, `${key}.json`), JSON.stringify(meta), 'utf8');
  } catch {
    // Caching is an optimisation: a read-only or full disk must not fail a diff.
  }
}

/** Refresh the freshness timestamp after a 304 Not Modified. */
export async function touchCache(
  meta: CacheMeta,
  options: { dir?: string } = {},
): Promise<void> {
  const dir = options.dir ?? cacheDir();
  const key = keyFor(meta.url);
  try {
    await writeFile(
      join(dir, `${key}.json`),
      JSON.stringify({ ...meta, fetchedAt: Date.now() }),
      'utf8',
    );
  } catch {
    /* non-fatal */
  }
}

/** Delete every cached specification. Returns the directory that was cleared. */
export async function clearCache(options: { dir?: string } = {}): Promise<string> {
  const dir = options.dir ?? cacheDir();
  await rm(dir, { recursive: true, force: true });
  return dir;
}

/** Number of cached documents and total bytes on disk. */
export async function cacheStats(
  options: { dir?: string } = {},
): Promise<{ dir: string; entries: number; bytes: number }> {
  const dir = options.dir ?? cacheDir();
  let entries = 0;
  let bytes = 0;
  try {
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.body')) continue;
      entries += 1;
      bytes += (await stat(join(dir, name))).size;
    }
  } catch {
    /* an absent cache directory is simply empty */
  }
  return { dir, entries, bytes };
}
