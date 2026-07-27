// Shared shapes and constants for the demo backend — the browser-side stand-in
// for the Go server, running inside a service worker (see sw.ts).
//
// These files are NOT ES modules: the demo tsconfig compiles them with
// `module: none` and concatenates them into a single classic worker script
// (web/static/demo-sw.js), so every declaration here is a plain global shared
// with the other demo files. A classic worker is deliberate — module service
// workers are still uneven across browsers, and the script must run wherever
// the static bundle is hosted.

/** A tag. Slug is the key and the display label, mirroring model.Tag. */
interface DemoTag {
  slug: string;
  createdAt: string;
}

/**
 * A stored note. `id` is the demo store's counterpart to the SQLite primary
 * key: the API never exposes it, but note ordering falls back to it as a
 * tiebreak exactly as the server's `ORDER BY … , id` clauses do.
 */
interface DemoNote {
  id: number;
  slug: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Tag slugs, in the order the API returns them (sorted, case-insensitive). */
  tags: string[];
}

/** An artifact's metadata; the bytes live in their own object store. */
interface DemoArtifact {
  sha256: string;
  contentType: string;
  createdAt: string;
}

/**
 * The whole note/tag dataset, persisted as one IndexedDB record. Artifact bytes
 * are excluded (they are far larger and are read one at a time), so a note edit
 * never rewrites image data.
 */
interface DemoState {
  nextNoteId: number;
  notes: DemoNote[];
  tags: DemoTag[];
}

/** demo-data.json, produced by internal/demo.BuildSeed. */
interface DemoSeed {
  lucideBundle: string;
  tags: DemoTag[];
  notes: Array<Omit<DemoNote, 'id'>>;
  artifacts: Array<DemoArtifact & { data: string }>;
}

/** The API's note-link projection: a wikilink edge with the target's title. */
interface NoteLinkDTO {
  slug: string;
  title: string;
}

// Limits, mirroring internal/service. Lengths count Unicode code points, as the
// Go side counts runes.
const MAX_TITLE_LEN = 200;
const MAX_CONTENT_LEN = 1_000_000;
const MAX_SLUG_LEN = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const FALLBACK_SLUG = 'note';

/**
 * An upload ceiling that does not exist on the server. Browser storage is a
 * shared, modest quota rather than a disk, so an oversized image is refused up
 * front with a clear message instead of failing later as an opaque quota error.
 */
const MAX_ARTIFACT_BYTES = 2 << 20; // 2 MiB

/**
 * A failure that maps to an HTTP status, mirroring how handler.NewError turns
 * the service layer's sentinel errors into status codes. The message travels in
 * the API's `{"error": "…"}` body.
 */
class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function validationError(message: string): ApiError {
  return new ApiError(400, message);
}

function notFoundError(): ApiError {
  return new ApiError(404, 'not found');
}

function conflictError(): ApiError {
  return new ApiError(409, 'slug already exists');
}

/** The UTC RFC 3339 form the server stores and the API emits. */
function nowTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Code-point count, matching Go's utf8.RuneCountInString. */
function runeLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
