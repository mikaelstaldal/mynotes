// Package model holds the shared domain types. They are independent of both
// the HTTP/OpenAPI layer and the storage layer so the service layer has a
// stable vocabulary to work with.
package model

import "time"

// Item is the single example domain entity for the template.
type Item struct {
	ID        int64
	Title     string
	Content   string
	CreatedAt time.Time
	UpdatedAt time.Time
}
