package repository

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/mikaelstaldal/go-web-template/internal/model"
)

// ItemRepository is the storage gateway for items. One repository struct per
// aggregate keeps SQL co-located with the data it touches.
type ItemRepository struct {
	db *sql.DB
}

func NewItemRepository(db *sql.DB) *ItemRepository {
	return &ItemRepository{db: db}
}

const rfc3339 = "2006-01-02T15:04:05Z07:00"

func scanItem(s interface{ Scan(...any) error }) (model.Item, error) {
	var (
		it                   model.Item
		createdAt, updatedAt string
	)
	if err := s.Scan(&it.ID, &it.Title, &it.Content, &createdAt, &updatedAt); err != nil {
		return model.Item{}, err
	}
	it.CreatedAt, _ = time.Parse(rfc3339, createdAt)
	it.UpdatedAt, _ = time.Parse(rfc3339, updatedAt)
	return it, nil
}

// List returns a page of items ordered newest-first. When query is non-empty
// the result is restricted to FTS matches.
func (r *ItemRepository) List(ctx context.Context, query string, limit, offset int) ([]model.Item, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if q := sanitizeFTSQuery(query); q != "" {
		rows, err = r.db.QueryContext(ctx, `
			SELECT i.id, i.title, i.content, i.created_at, i.updated_at
			FROM items i
			JOIN items_fts f ON f.rowid = i.id
			WHERE items_fts MATCH ?
			ORDER BY i.created_at DESC
			LIMIT ? OFFSET ?`, q, limit, offset)
	} else {
		rows, err = r.db.QueryContext(ctx, `
			SELECT id, title, content, created_at, updated_at
			FROM items
			ORDER BY created_at DESC
			LIMIT ? OFFSET ?`, limit, offset)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]model.Item, 0)
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	return items, rows.Err()
}

// GetByID returns the item, or ErrNotFound if it does not exist.
func (r *ItemRepository) GetByID(ctx context.Context, id int64) (model.Item, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, title, content, created_at, updated_at FROM items WHERE id = ?`, id)
	it, err := scanItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Item{}, ErrNotFound
	}
	return it, err
}

func (r *ItemRepository) Create(ctx context.Context, title, content string) (model.Item, error) {
	now := time.Now().UTC().Format(rfc3339)
	res, err := r.db.ExecContext(ctx, `
		INSERT INTO items (title, content, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		title, content, now, now)
	if err != nil {
		return model.Item{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return model.Item{}, err
	}
	return r.GetByID(ctx, id)
}

// Update applies the non-nil fields and returns the updated item. A nil field
// is left unchanged. Returns ErrNotFound if the item does not exist.
func (r *ItemRepository) Update(ctx context.Context, id int64, title, content *string) (model.Item, error) {
	sets := []string{"updated_at = ?"}
	args := []any{time.Now().UTC().Format(rfc3339)}
	if title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *title)
	}
	if content != nil {
		sets = append(sets, "content = ?")
		args = append(args, *content)
	}
	args = append(args, id)

	res, err := r.db.ExecContext(ctx,
		"UPDATE items SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...)
	if err != nil {
		return model.Item{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return model.Item{}, ErrNotFound
	}
	return r.GetByID(ctx, id)
}

// Delete removes the item, returning ErrNotFound if it did not exist.
func (r *ItemRepository) Delete(ctx context.Context, id int64) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM items WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// sanitizeFTSQuery turns arbitrary user input into a safe FTS5 MATCH string by
// treating every token as a literal: each token is wrapped in double quotes
// (with internal quotes doubled), so FTS5 operators like AND/OR/NEAR and
// special characters cannot break out. Returns "" when there is nothing to
// match, signalling the caller to fall back to an unfiltered list.
func sanitizeFTSQuery(query string) string {
	fields := strings.Fields(query)
	tokens := make([]string, 0, len(fields))
	for _, f := range fields {
		f = strings.ReplaceAll(f, `"`, `""`)
		tokens = append(tokens, `"`+f+`"`)
	}
	return strings.Join(tokens, " ")
}
