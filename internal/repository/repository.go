// Package repository implements SQLite-backed storage. The exported sentinel
// errors below are the contract between this layer and the service layer:
// callers branch on them with errors.Is rather than inspecting SQL errors.
package repository

import "errors"

var (
	// ErrNotFound is returned when a requested row does not exist.
	ErrNotFound = errors.New("not found")
	// ErrConflict is returned when a write violates the slug UNIQUE constraint
	// (the DB is the authority on slug uniqueness). The service maps it to 409.
	ErrConflict = errors.New("slug already exists")
)
