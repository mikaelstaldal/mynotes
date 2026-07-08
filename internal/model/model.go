// Package model holds the shared domain types. They are independent of both
// the HTTP/OpenAPI layer and the storage layer so the service layer has a
// stable vocabulary to work with.
package model

import "time"

// Note is the single domain entity. Content is verbatim Markdown source. ID is
// the internal SQLite primary key; the API addresses notes by Slug and never
// exposes ID. Tags is populated by the repository (batched, never lazy-loaded
// per row) and is []Tag{} rather than nil when the note has no tags.
type Note struct {
	ID        int64
	Slug      string
	Title     string
	Content   string
	CreatedAt time.Time
	UpdatedAt time.Time
	Version   int
	Tags      []Tag
}

// NoteSummary is the list/search projection of a note: the addressable Slug, the
// display Title and UpdatedAt, plus a repository-built Excerpt (a plain prefix
// when browsing, an FTS snippet when searching). Excerpt is "" when empty, never
// absent. Tags mirrors Note.Tags (never nil).
type NoteSummary struct {
	Slug      string
	Title     string
	Excerpt   string
	CreatedAt time.Time
	UpdatedAt time.Time
	Version   int
	Tags      []Tag
}

// Tag is a label attachable to notes many-to-many. Slug is the addressable,
// unique key and also serves as the display label.
type Tag struct {
	ID        int64
	Slug      string
	CreatedAt time.Time
}

// Artifact is a binary blob stored content-addressed by SHA-256. SHA256 is the
// hex-encoded digest (64 lowercase chars) and serves as the primary key.
type Artifact struct {
	SHA256      string
	Content     []byte
	ContentType string
	CreatedAt   time.Time
}
