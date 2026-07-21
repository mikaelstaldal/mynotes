// Package model holds the shared domain types. They are independent of both
// the HTTP/OpenAPI layer and the storage layer so the service layer has a
// stable vocabulary to work with.
package model

import "time"

// Note is the single domain entity. Content is verbatim Markdown source. ID is
// the internal SQLite primary key; the API addresses notes by Slug and never
// exposes ID. Tags is populated by the repository (batched, never lazy-loaded
// per row) and is []Tag{} rather than nil when the note has no tags.
// IncomingLinks/OutgoingLinks are the note's wikilink relationships, likewise
// batched by the repository and never nil (see NoteLink).
type Note struct {
	ID            int64
	Slug          string
	Title         string
	Content       string
	CreatedAt     time.Time
	UpdatedAt     time.Time
	Version       int
	Tags          []Tag
	IncomingLinks []NoteLink
	OutgoingLinks []NoteLink
}

// NoteSummary is the list/search projection of a note: the addressable Slug, the
// display Title and UpdatedAt, plus a repository-built Excerpt (a plain prefix
// when browsing, an FTS snippet when searching). Excerpt is "" when empty, never
// absent. Tags mirrors Note.Tags (never nil); IncomingLinks/OutgoingLinks mirror
// Note's link fields (never nil).
type NoteSummary struct {
	Slug          string
	Title         string
	Excerpt       string
	CreatedAt     time.Time
	UpdatedAt     time.Time
	Version       int
	Tags          []Tag
	IncomingLinks []NoteLink
	OutgoingLinks []NoteLink
}

// NoteLink is one edge of the note-to-note wikilink graph: a reference to
// another note by its addressable Slug, paired with that note's current Title
// (resolved at read time, so it always reflects the target's latest title).
// Only links whose target note exists are represented — dangling wikilinks are
// omitted. Tag links ([[#slug]]) are not part of this graph.
type NoteLink struct {
	Slug  string
	Title string
}

// Tag is a label attachable to notes many-to-many. Slug is the addressable,
// unique key and also serves as the display label.
type Tag struct {
	ID        int64
	Slug      string
	CreatedAt time.Time
}

// TagSummary is the tag-listing projection: a tag's Slug plus NoteCount, the
// number of notes currently carrying it. It powers the tag-management view,
// where a tag with attached notes is deleted only after confirmation.
type TagSummary struct {
	Slug      string
	NoteCount int
}

// Artifact is a binary blob stored content-addressed by SHA-256. SHA256 is the
// hex-encoded digest (64 lowercase chars) and serves as the primary key.
type Artifact struct {
	SHA256      string
	Content     []byte
	ContentType string
	CreatedAt   time.Time
}
