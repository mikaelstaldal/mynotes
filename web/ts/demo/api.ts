// The demo backend's REST layer: the counterpart of internal/handler and the
// use-case half of internal/service, answering the same /api/v1 routes the Go
// server does, from browser-local storage.
//
// Everything the web UI sends goes through here — including the requests that
// never touch web/ts/api/client.ts, namely the <img src> loads for artifacts
// and icons and the "Download Markdown" navigation. Intercepting at the network
// layer rather than swapping the API client out is what keeps the frontend
// unchanged between the demo and the real thing.
//
// See model.ts for why these are globals rather than module exports.

// ── Response helpers ─────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return jsonResponse(err.status, { error: err.message });
  return jsonResponse(500, { error: 'internal server error: ' + String(err) });
}

function noContentResponse(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

function etag(version: number): string {
  return `"${version}"`;
}

// ── Projections ──────────────────────────────────────────────────────────────

/** SQLite's NOCASE collation: ASCII case folding, used for every title/slug sort. */
function compareNoCase(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The wikilink graph over the whole store: each note's resolvable outgoing
 * links (by id) and each slug's backlinks. The server keeps this in the
 * note_links table, maintained on every write; a demo-sized store is small
 * enough to derive it per request, which cannot go stale.
 */
interface LinkIndex {
  outgoing: Map<number, NoteLinkDTO[]>;
  incoming: Map<string, NoteLinkDTO[]>;
}

function buildLinkIndex(state: DemoState): LinkIndex {
  const bySlug = new Map<string, DemoNote>();
  for (const note of state.notes) bySlug.set(note.slug, note);

  const outgoing = new Map<number, NoteLinkDTO[]>();
  const incoming = new Map<string, NoteLinkDTO[]>();
  for (const note of state.notes) {
    for (const target of extractNoteLinks(note.content, note.slug)) {
      // A link whose target does not exist is dangling: the server's read-time
      // JOIN drops it, so it is left out here too.
      const targetNote = bySlug.get(target);
      if (targetNote === undefined) continue;
      pushLink(outgoing, note.id, { slug: targetNote.slug, title: targetNote.title });
      pushLink(incoming, target, { slug: note.slug, title: note.title });
    }
  }
  for (const links of outgoing.values()) links.sort((a, b) => compareNoCase(a.title, b.title));
  for (const links of incoming.values()) links.sort((a, b) => compareNoCase(a.title, b.title));
  return { outgoing, incoming };
}

function pushLink<K>(map: Map<K, NoteLinkDTO[]>, key: K, link: NoteLinkDTO): void {
  const links = map.get(key);
  if (links === undefined) map.set(key, [link]);
  else links.push(link);
}

function toTagDTOs(slugs: string[]): Array<{ slug: string }> {
  return slugs.map((slug) => ({ slug }));
}

function toNoteDTO(note: DemoNote, links: LinkIndex): unknown {
  return {
    slug: note.slug,
    title: note.title,
    content: note.content,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    version: note.version,
    tags: toTagDTOs(note.tags),
    incoming_links: links.incoming.get(note.slug) ?? [],
    outgoing_links: links.outgoing.get(note.id) ?? [],
  };
}

function toSummaryDTO(note: DemoNote, excerpt: string, links: LinkIndex): unknown {
  return {
    slug: note.slug,
    title: note.title,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    excerpt,
    version: note.version,
    tags: toTagDTOs(note.tags),
    incoming_links: links.incoming.get(note.slug) ?? [],
    outgoing_links: links.outgoing.get(note.id) ?? [],
  };
}

// ── Note helpers ─────────────────────────────────────────────────────────────

function findNote(state: DemoState, slug: string): DemoNote {
  const note = state.notes.find((n) => n.slug === slug);
  if (note === undefined) throw notFoundError();
  return note;
}

/**
 * Resolves tag slugs to an ordered, de-duped set, rejecting any that names no
 * existing tag: tags must be created explicitly before they can be attached.
 * Mirrors service.resolveTagIDs.
 */
function resolveTags(state: DemoState, slugs: string[]): string[] {
  const known = new Set(state.tags.map((t) => t.slug));
  const out: string[] = [];
  for (const slug of slugs) {
    if (out.includes(slug)) continue;
    if (!known.has(slug)) throw validationError('unknown tag: ' + slug);
    out.push(slug);
  }
  return out.sort(compareNoCase);
}

/** base if free, else base-2, base-3, … Mirrors service.uniqueSlug. */
function uniqueSlug(state: DemoState, base: string): string {
  const taken = new Set(state.notes.map((n) => n.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = slugWithSuffix(base, n);
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Creates a note. An explicit slug is used verbatim and a collision is a 409; a
 * derived one is de-conflicted with a numeric suffix. Mirrors
 * service.createNote — the caller persists the state.
 */
function createNote(
  state: DemoState,
  title: string,
  content: string,
  slug: string | null,
  tagSlugs: string[],
  createdAt: string,
  updatedAt: string,
): DemoNote {
  const trimmed = title.trim();
  validateTitle(trimmed);
  validateContent(content);
  const tags = resolveTags(state, tagSlugs);

  if (slug !== null) {
    validateSlug(slug);
    if (state.notes.some((n) => n.slug === slug)) throw conflictError();
  } else {
    slug = uniqueSlug(state, generateSlug(trimmed));
  }

  const note: DemoNote = {
    id: state.nextNoteId++,
    slug,
    title: trimmed,
    content,
    createdAt,
    updatedAt,
    version: 1,
    tags,
  };
  state.notes.push(note);
  return note;
}

/** Truncates a title to MAX_TITLE_LEN with an ellipsis, as the import paths do. */
function clampTitle(title: string): string {
  const runes = [...title];
  return runes.length > MAX_TITLE_LEN ? runes.slice(0, MAX_TITLE_LEN - 1).join('') + '…' : title;
}

/**
 * Creates any tag in slugs that does not exist yet, so an imported note can
 * carry tags that were never explicitly created. Mirrors service.ensureTags.
 */
function ensureTags(state: DemoState, slugs: string[]): void {
  for (const slug of slugs) {
    if (state.tags.some((t) => t.slug === slug)) continue;
    validateSlug(slug);
    state.tags.push({ slug, createdAt: nowTimestamp() });
  }
}

// ── Notes ────────────────────────────────────────────────────────────────────

async function listNotes(url: URL): Promise<Response> {
  return withStore(async (state) => {
    const params = url.searchParams;
    const query = params.get('q') ?? '';
    const tagSlugs = [...new Set(params.getAll('tag'))];
    const titlePrefix = params.get('titlePrefix') === 'true';
    const sort = params.get('sort') ?? 'updated';
    const order = params.get('order') === 'asc' ? 'asc' : 'desc';
    let limit = Number(params.get('limit') ?? DEFAULT_LIMIT);
    let offset = Number(params.get('offset') ?? 0);
    if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_LIMIT) limit = DEFAULT_LIMIT;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    // Notes carrying ALL of the requested tags (AND semantics).
    let candidates = state.notes;
    if (tagSlugs.length > 0) {
      candidates = candidates.filter((n) => tagSlugs.every((t) => n.tags.includes(t)));
    }

    // The excerpt probe lengths mirror the server's substr() windows.
    let matched: Array<{ note: DemoNote; excerpt: string }>;
    const prefix = query.trim();
    const terms = titlePrefix ? [] : searchTerms(query);

    if (titlePrefix && prefix !== '') {
      matched = candidates
        .filter((n) => n.title.toLowerCase().startsWith(prefix.toLowerCase()))
        .sort((a, b) => compareNoCase(a.title, b.title) || b.id - a.id)
        .map((note) => ({ note, excerpt: plainExcerpt(note.content.slice(0, 501)) }));
    } else if (terms.length > 0) {
      matched = candidates
        .map((note) => ({ note, hit: searchNote(note, terms) }))
        .filter((m) => m.hit.matched)
        .sort((a, b) => b.hit.score - a.hit.score || b.note.id - a.note.id)
        .map(({ note, hit }) => ({
          note,
          // A snippet is used only when the match was in the content; otherwise
          // (a title-only match) fall back to the plain prefix, as the server
          // does when the snippet carries no start sentinel.
          excerpt: hit.snippet !== '' ? hit.snippet : plainExcerpt(note.content.slice(0, 201)),
        }));
    } else {
      matched = candidates
        .slice()
        .sort((a, b) => browseCompare(a, b, sort, order))
        .map((note) => ({ note, excerpt: plainExcerpt(note.content.slice(0, 501)) }));
    }

    const links = buildLinkIndex(state);
    return jsonResponse(200, {
      total: matched.length,
      notes: matched.slice(offset, offset + limit)
        .map(({ note, excerpt }) => toSummaryDTO(note, excerpt, links)),
    });
  });
}

/** The browse ordering, with the id tiebreak that keeps paging stable. */
function browseCompare(a: DemoNote, b: DemoNote, sort: string, order: string): number {
  let cmp: number;
  if (sort === 'created') cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  else if (sort === 'title') cmp = compareNoCase(a.title, b.title);
  else cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
  if (cmp === 0) cmp = a.id - b.id;
  return order === 'asc' ? cmp : -cmp;
}

async function getNote(slug: string): Promise<Response> {
  return withStore(async (state) => {
    const note = findNote(state, slug);
    return jsonResponse(200, toNoteDTO(note, buildLinkIndex(state)), { ETag: etag(note.version) });
  });
}

async function postNote(request: Request): Promise<Response> {
  const body = await readJSONBody(request);
  return withStore(async (state) => {
    const now = nowTimestamp();
    const note = createNote(
      state,
      stringField(body, 'title') ?? '',
      stringField(body, 'content') ?? '',
      stringField(body, 'slug') ?? null,
      stringArrayField(body, 'tags') ?? [],
      now,
      now,
    );
    await saveState(state);
    return jsonResponse(201, toNoteDTO(note, buildLinkIndex(state)));
  });
}

async function patchNote(slug: string, request: Request): Promise<Response> {
  const body = await readJSONBody(request);
  const ifMatch = request.headers.get('If-Match');
  return withStore(async (state) => {
    const title = stringField(body, 'title');
    const content = stringField(body, 'content');
    const tags = stringArrayField(body, 'tags');
    if (title === null && content === null && tags === null) {
      throw validationError('no fields to update');
    }

    const trimmedTitle = title === null ? null : title.trim();
    if (trimmedTitle !== null) validateTitle(trimmedTitle);
    if (content !== null) validateContent(content);
    const resolvedTags = tags === null ? null : resolveTags(state, tags);

    const note = findNote(state, slug);
    if (ifMatch !== null && Number(ifMatch.replace(/"/g, '')) !== note.version) {
      throw new ApiError(412, 'version mismatch');
    }

    // Only genuinely-changed fields count; if nothing differs the note is
    // returned untouched and its version does not move.
    const changed = (trimmedTitle !== null && trimmedTitle !== note.title)
      || (content !== null && content !== note.content)
      || (resolvedTags !== null && !sameTagSet(resolvedTags, note.tags));
    if (changed) {
      if (trimmedTitle !== null) note.title = trimmedTitle;
      if (content !== null) note.content = content;
      if (resolvedTags !== null) note.tags = resolvedTags;
      note.version++;
      note.updatedAt = nowTimestamp();
      await saveState(state);
    }
    return jsonResponse(200, toNoteDTO(note, buildLinkIndex(state)), { ETag: etag(note.version) });
  });
}

function sameTagSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((slug) => b.includes(slug));
}

async function deleteNote(slug: string): Promise<Response> {
  return withStore(async (state) => {
    const note = findNote(state, slug);
    state.notes.splice(state.notes.indexOf(note), 1);
    await saveState(state);
    return noContentResponse();
  });
}

async function splitNote(slug: string, request: Request): Promise<Response> {
  const body = await readJSONBody(request);
  return withStore(async (state) => {
    const source = findNote(state, slug);
    const tag = stringField(body, 'tag');
    const tagSlugs = tag !== null && tag !== '' ? [tag] : [];
    // Resolve up front so an unknown tag fails before any note is written,
    // rather than leaving a partial split behind.
    resolveTags(state, tagSlugs);

    const sections = splitByHeadings(source.content);
    if (sections.length === 0) throw validationError('note has no headings to split on');

    // Pre-validate every section so an invalid one is rejected before any note
    // is created.
    const titles = sections.map((section) => {
      const title = clampTitle(section.title);
      validateTitle(title.trim());
      validateContent(section.body);
      return title;
    });

    const created = sections.map((section, i) => createNote(
      state, titles[i], section.body, null, tagSlugs, source.createdAt, source.updatedAt));
    await saveState(state);

    // The server assembles these summaries by hand and leaves their link fields
    // empty rather than querying the index it has just written, so the split
    // response carries no links; the client re-reads the notes anyway.
    const noLinks: LinkIndex = { outgoing: new Map(), incoming: new Map() };
    return jsonResponse(201, {
      notes: created.map((note) => toSummaryDTO(note, plainExcerpt(note.content), noLinks)),
    });
  });
}

async function downloadNoteMarkdown(slug: string): Promise<Response> {
  return withStore(async (state) => {
    const note = findNote(state, slug);
    return new Response(markdownWithFrontmatter(note), {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${note.slug}.md"`,
        'Cache-Control': 'no-store',
      },
    });
  });
}

// ── Import ───────────────────────────────────────────────────────────────────

/**
 * Imports an HTML or Markdown document as a note. HTML is converted on the
 * page: a service worker has no DOMParser, and the page already has both the
 * DOM and the converter (web/ts/util/htmlmd.ts), so the worker asks its client
 * to do that one step. Everything else — titles, frontmatter, slugs, tags —
 * happens here, exactly as ImportHTML/ImportMarkdown do on the server.
 */
async function importNote(request: Request, clientId: string): Promise<Response> {
  const contentType = (request.headers.get('Content-Type') ?? '').split(';')[0].trim();
  const source = await request.text();

  let title: string;
  let markdown: string;
  let slug: string | null = null;
  let createdAt = nowTimestamp();
  let tagSlugs: string[] = [];

  if (contentType === 'text/html') {
    const converted = await htmlToMarkdown(clientId, source);
    markdown = converted.content;
    title = converted.title !== '' ? converted.title : firstATXHeading(markdown);
  } else if (contentType === 'text/markdown') {
    const { fm, body } = parseFrontmatter(source);
    markdown = body;
    title = fm.title !== '' ? fm.title : firstATXHeading(body);
    if (fm.slug !== '') slug = fm.slug;
    if (fm.date !== '') createdAt = fm.date;
    tagSlugs = fm.tags;
  } else {
    throw validationError('unsupported content type: ' + contentType);
  }

  title = clampTitle(title);
  return withStore(async (state) => {
    ensureTags(state, tagSlugs);
    const note = createNote(state, title, markdown, slug, tagSlugs, createdAt, createdAt);
    await saveState(state);
    return jsonResponse(201, toNoteDTO(note, buildLinkIndex(state)));
  });
}

// ── Tags ─────────────────────────────────────────────────────────────────────

async function listTags(): Promise<Response> {
  return withStore(async (state) => jsonResponse(200, {
    tags: state.tags
      .slice()
      .sort((a, b) => compareNoCase(a.slug, b.slug))
      .map((tag) => ({
        slug: tag.slug,
        note_count: state.notes.filter((n) => n.tags.includes(tag.slug)).length,
      })),
  }));
}

async function postTag(request: Request): Promise<Response> {
  const body = await readJSONBody(request);
  return withStore(async (state) => {
    const slug = stringField(body, 'slug') ?? '';
    validateSlug(slug);
    if (state.tags.some((t) => t.slug === slug)) throw conflictError();
    state.tags.push({ slug, createdAt: nowTimestamp() });
    await saveState(state);
    return jsonResponse(201, { slug });
  });
}

async function deleteTag(slug: string): Promise<Response> {
  return withStore(async (state) => {
    const index = state.tags.findIndex((t) => t.slug === slug);
    if (index < 0) throw notFoundError();
    state.tags.splice(index, 1);
    // Detaching from every note mirrors the schema's ON DELETE CASCADE.
    for (const note of state.notes) {
      const at = note.tags.indexOf(slug);
      if (at >= 0) note.tags.splice(at, 1);
    }
    await saveState(state);
    return noContentResponse();
  });
}

// ── Artifacts ────────────────────────────────────────────────────────────────

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The artifact media types the API accepts, from openapi.yaml. */
const ARTIFACT_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/svg+xml', 'application/mathml+xml',
]);

/**
 * Verifies that content matches its declared type, so a stored artifact's
 * Content-Type is a guarantee rather than a claim. Mirrors
 * service.validateArtifactContent: raster formats by magic bytes, SVG and
 * MathML by their root element (checked by inspection here rather than with an
 * XML parser, which a worker does not have).
 */
function validateArtifactContent(bytes: Uint8Array, contentType: string): void {
  const startsWith = (...magic: number[]): boolean =>
    magic.every((b, i) => bytes[i] === b);
  const bad = () => validationError('content does not match declared type ' + contentType);

  switch (contentType) {
    case 'image/png':
      if (!startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) throw bad();
      break;
    case 'image/jpeg':
      if (!startsWith(0xff, 0xd8, 0xff)) throw bad();
      break;
    case 'image/gif':
      if (!startsWith(0x47, 0x49, 0x46, 0x38)) throw bad();
      break;
    case 'image/webp':
      if (bytes.length < 12 || !startsWith(0x52, 0x49, 0x46, 0x46)
        || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') throw bad();
      break;
    case 'image/svg+xml':
      if (!hasXMLRoot(bytes, 'svg')) {
        throw validationError('content is not well-formed XML with root element <svg>');
      }
      break;
    case 'application/mathml+xml':
      if (!hasXMLRoot(bytes, 'math')) {
        throw validationError('content is not well-formed XML with root element <math>');
      }
      break;
  }
}

/** Whether the first element of an XML document has the expected local name. */
function hasXMLRoot(bytes: Uint8Array, expected: string): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 4096))
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  const m = /<([a-zA-Z][\w.\-]*:)?([a-zA-Z][\w.\-]*)/.exec(head);
  return m !== null && m[2] === expected;
}

async function postArtifact(request: Request): Promise<Response> {
  const contentType = (request.headers.get('Content-Type') ?? '').split(';')[0].trim();
  if (!ARTIFACT_TYPES.has(contentType)) throw validationError('invalid content type');

  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) throw validationError('artifact content must not be empty');
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw validationError(
      `image is too large for the demo: at most ${MAX_ARTIFACT_BYTES >> 20} MiB, this one is `
      + `${Math.ceil(bytes.length / (1 << 20))} MiB`);
  }
  validateArtifactContent(bytes, contentType);

  const sha256 = await sha256Hex(buffer);
  const createdAt = nowTimestamp();
  const existing = await getArtifact(sha256);
  // Content-addressed: uploading the same bytes twice is idempotent.
  if (existing === undefined) await putArtifact({ sha256, contentType, createdAt, data: buffer });
  return jsonResponse(201, {
    sha256,
    content_type: existing?.contentType ?? contentType,
    created_at: existing?.createdAt ?? createdAt,
  });
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function serveArtifact(sha256: string): Promise<Response> {
  if (!SHA256_HEX.test(sha256)) throw notFoundError();
  const artifact = await getArtifact(sha256);
  if (artifact === undefined) throw notFoundError();
  const headers: Record<string, string> = {
    'Content-Type': artifact.contentType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable',
  };
  // SVG and MathML are active content: navigating to one directly on the app
  // origin could otherwise execute script. A sandboxed policy prevents that
  // without affecting <img> rendering, where response headers are ignored.
  if (artifact.contentType === 'image/svg+xml' || artifact.contentType === 'application/mathml+xml') {
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }
  return new Response(artifact.data, { status: 200, headers });
}

async function deleteArtifact(sha256: string): Promise<Response> {
  if (!SHA256_HEX.test(sha256)) throw notFoundError();
  if ((await getArtifact(sha256)) === undefined) throw notFoundError();
  await removeArtifact(sha256);
  return noContentResponse();
}

// ── Icons ────────────────────────────────────────────────────────────────────

async function serveIcon(name: string): Promise<Response> {
  const svg = (await lucideIcons()).get(name);
  if (svg === undefined) throw notFoundError();
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

// ── Request body helpers ─────────────────────────────────────────────────────

/** Parses a JSON request body, treating an absent or empty one as `{}`. */
async function readJSONBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw validationError('request body must be a JSON object');
    }
    return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw validationError('invalid JSON request body');
  }
}

/** A string field, or null when the key is absent (PATCH's "leave unchanged"). */
function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw validationError(`${key} must be a string`);
  return value;
}

/** A string-array field, or null when the key is absent. */
function stringArrayField(body: Record<string, unknown>, key: string): string[] | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw validationError(`${key} must be an array of strings`);
  }
  return value as string[];
}

// ── Routing ──────────────────────────────────────────────────────────────────

/**
 * Dispatches an /api/v1 request. `path` is the part after the prefix, with a
 * leading slash (e.g. "/notes/my-note"). Mirrors the route table main.go builds
 * on its ServeMux plus the operations ogen routes from openapi.yaml.
 */
async function handleApiRequest(path: string, request: Request, clientId: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const segments = path.split('/').filter((s) => s !== '').map(decodeURIComponent);

    if (segments[0] === 'notes') {
      if (segments.length === 1) {
        if (method === 'GET') return await listNotes(url);
        if (method === 'POST') return await postNote(request);
      } else if (segments.length === 2) {
        if (method === 'GET') return await getNote(segments[1]);
        if (method === 'PATCH') return await patchNote(segments[1], request);
        if (method === 'DELETE') return await deleteNote(segments[1]);
      } else if (segments.length === 3 && segments[2] === 'split' && method === 'POST') {
        return await splitNote(segments[1], request);
      } else if (segments.length === 3 && segments[2] === 'download-markdown' && method === 'GET') {
        return await downloadNoteMarkdown(segments[1]);
      }
    } else if (segments[0] === 'tags') {
      if (segments.length === 1) {
        if (method === 'GET') return await listTags();
        if (method === 'POST') return await postTag(request);
      } else if (segments.length === 2 && method === 'DELETE') {
        return await deleteTag(segments[1]);
      }
    } else if (segments[0] === 'artifacts') {
      if (segments.length === 1 && method === 'POST') return await postArtifact(request);
      if (segments.length === 2 && method === 'GET') return await serveArtifact(segments[1]);
      if (segments.length === 2 && method === 'DELETE') return await deleteArtifact(segments[1]);
    } else if (segments[0] === 'import' && segments.length === 1 && method === 'POST') {
      return await importNote(request, clientId);
    } else if (segments[0] === 'icons' && segments.length === 3 && method === 'GET') {
      if (segments[1] === 'lucide') return await serveIcon(segments[2]);
      throw notFoundError();
    }
    return jsonResponse(404, { error: 'not found' });
  } catch (err) {
    return errorResponse(err);
  }
}
