package demo

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"sync/atomic"

	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"
	"github.com/mikaelstaldal/mynotes/web"
)

// SeedFileName is the file the browser demo fetches its initial content from.
// It sits next to index.html, so the service worker resolves it relative to its
// own scope and the same file works at any deployment path.
const SeedFileName = "demo-data.json"

// Seed is the JSON document the demo service worker seeds its browser-side
// store from. It is the exact same demo content the -demo flag writes into
// SQLite: rather than duplicating it in JavaScript, Seed runs the real seeding
// pipeline (service layer included, so slugs, digests, and validation all
// behave identically) against a throwaway in-memory database and dumps the
// result.
type Seed struct {
	// LucideBundle is the static path of the vendored Lucide bundle, relative to
	// the deployment root (e.g. "vendor/lucide-1.25.0.js"). The service worker
	// reconstructs icon SVGs from it to answer GET /api/v1/icons/lucide/{name},
	// mirroring internal/icons. Resolved here because the filename carries a
	// version the worker must not have to guess.
	LucideBundle string `json:"lucideBundle"`

	Tags      []SeedTag      `json:"tags"`
	Notes     []SeedNote     `json:"notes"`
	Artifacts []SeedArtifact `json:"artifacts"`
}

type SeedTag struct {
	Slug      string `json:"slug"`
	CreatedAt string `json:"createdAt"`
}

type SeedNote struct {
	Slug      string   `json:"slug"`
	Title     string   `json:"title"`
	Content   string   `json:"content"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
	Version   int      `json:"version"`
	Tags      []string `json:"tags"`
}

type SeedArtifact struct {
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
	CreatedAt   string `json:"createdAt"`
	// Data is the artifact content, base64-encoded (standard alphabet, padded).
	Data string `json:"data"`
}

// BuildSeed produces the demo seed document. It opens a private in-memory
// SQLite database, runs the normal Run seeding through the service layer, then
// reads the stored rows back out. Nothing touches the filesystem and the
// database is discarded on return.
func BuildSeed(ctx context.Context) (*Seed, error) {
	db, err := openSeedDB()
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()

	noteRepo := repository.NewNoteRepository(db)
	tagRepo := repository.NewTagRepository(db)
	artifactRepo := repository.NewArtifactRepository(db)
	if err := Run(ctx,
		service.NewNoteService(noteRepo, tagRepo),
		service.NewArtifactService(artifactRepo),
		service.NewTagService(tagRepo),
		io.Discard,
	); err != nil {
		return nil, err
	}

	lucide, err := lucideBundlePath()
	if err != nil {
		return nil, err
	}
	seed := &Seed{LucideBundle: lucide}
	if seed.Tags, err = exportTags(ctx, db); err != nil {
		return nil, err
	}
	if seed.Notes, err = exportNotes(ctx, db); err != nil {
		return nil, err
	}
	if seed.Artifacts, err = exportArtifacts(ctx, db); err != nil {
		return nil, err
	}
	return seed, nil
}

// BuildSeedJSON is BuildSeed marshalled to the bytes served as demo-data.json.
func BuildSeedJSON(ctx context.Context) ([]byte, error) {
	seed, err := BuildSeed(ctx)
	if err != nil {
		return nil, err
	}
	return json.Marshal(seed)
}

// seedDBCounter makes each in-memory database name unique, so two concurrent
// BuildSeed calls (e.g. parallel tests) never share the `cache=shared` store.
var seedDBCounter atomic.Uint64

// openSeedDB opens a private, empty, fully-migrated in-memory database. The
// connection pool is pinned to one connection: a `cache=shared` in-memory
// database lives only as long as at least one connection is open.
func openSeedDB() (*sql.DB, error) {
	dsn := fmt.Sprintf("file:demoseed%d?mode=memory&cache=shared&_pragma=foreign_keys(on)",
		seedDBCounter.Add(1))

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open seed database: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := repository.InitSchema(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate seed database: %w", err)
	}
	return db, nil
}

// lucideBundlePath locates the single vendored Lucide bundle in the embedded
// assets and returns its path relative to the deployment root. Mirrors the glob
// in internal/icons so a version bump needs no edit in either place.
func lucideBundlePath() (string, error) {
	matches, err := fs.Glob(web.Static, "static/vendor/lucide-*.js")
	if err != nil {
		return "", fmt.Errorf("glob lucide bundle: %w", err)
	}
	if len(matches) != 1 {
		return "", fmt.Errorf("expected exactly one static/vendor/lucide-*.js, found %d", len(matches))
	}
	return matches[0][len("static/"):], nil
}

func exportTags(ctx context.Context, db *sql.DB) ([]SeedTag, error) {
	rows, err := db.QueryContext(ctx, `SELECT slug, created_at FROM tags ORDER BY slug`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	tags := make([]SeedTag, 0)
	for rows.Next() {
		var t SeedTag
		if err := rows.Scan(&t.Slug, &t.CreatedAt); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

func exportNotes(ctx context.Context, db *sql.DB) ([]SeedNote, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT n.id, n.slug, n.title, n.content, n.created_at, n.updated_at, n.version
		FROM notes n ORDER BY n.id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	notes := make([]SeedNote, 0)
	ids := make([]int64, 0)
	for rows.Next() {
		var (
			id int64
			n  SeedNote
		)
		if err := rows.Scan(&id, &n.Slug, &n.Title, &n.Content, &n.CreatedAt, &n.UpdatedAt, &n.Version); err != nil {
			return nil, err
		}
		n.Tags = []string{}
		notes = append(notes, n)
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	byNoteID := make(map[int64]int, len(ids))
	for i, id := range ids {
		byNoteID[id] = i
	}
	tagRows, err := db.QueryContext(ctx, `
		SELECT nt.note_id, t.slug
		FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
		ORDER BY nt.note_id, t.slug`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tagRows.Close() }()
	for tagRows.Next() {
		var (
			noteID int64
			slug   string
		)
		if err := tagRows.Scan(&noteID, &slug); err != nil {
			return nil, err
		}
		if i, ok := byNoteID[noteID]; ok {
			notes[i].Tags = append(notes[i].Tags, slug)
		}
	}
	return notes, tagRows.Err()
}

func exportArtifacts(ctx context.Context, db *sql.DB) ([]SeedArtifact, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT sha256, content, content_type, created_at FROM artifacts ORDER BY sha256`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	artifacts := make([]SeedArtifact, 0)
	for rows.Next() {
		var (
			a       SeedArtifact
			content []byte
		)
		if err := rows.Scan(&a.SHA256, &content, &a.ContentType, &a.CreatedAt); err != nil {
			return nil, err
		}
		a.Data = base64.StdEncoding.EncodeToString(content)
		artifacts = append(artifacts, a)
	}
	return artifacts, rows.Err()
}
