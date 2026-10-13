package repository

import (
	"context"
	"github.com/mikaelstaldal/go-server-common/devicegrant"
	"github.com/mikaelstaldal/go-server-common/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestDeviceSchemaMatchesSharedDDL(t *testing.T) { assert.Equal(t, devicegrant.DDL, deviceSchemaV8) }

func TestTokenMigrationPreservesNotes(t *testing.T) {
	db, err := sqlite.Open(t.TempDir()+"/old.sqlite", 5000, migrations[:7])
	require.NoError(t, err)
	defer db.Close()
	_, err = db.Exec(`INSERT INTO notes(slug,title,content,created_at,updated_at) VALUES('old','Old note','keep me','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`)
	require.NoError(t, err)
	require.NoError(t, InitSchema(db))
	require.NoError(t, InitSchema(db))
	var content string
	require.NoError(t, db.QueryRowContext(context.Background(), `SELECT content FROM notes WHERE slug='old'`).Scan(&content))
	assert.Equal(t, "keep me", content)
	for _, table := range []string{"api_tokens", "device_authorizations"} {
		var count int
		require.NoError(t, db.QueryRow(`SELECT count(*) FROM `+table).Scan(&count))
		assert.Zero(t, count)
	}
}
