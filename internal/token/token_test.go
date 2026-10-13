package token

import (
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func testStore(t *testing.T) Store {
	t.Helper()
	db, err := repository.OpenDB(t.TempDir()+"/tokens.sqlite", 5000)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, db.Close()) })
	return Store{DB: db}
}

func TestTokenStorageAndValidation(t *testing.T) {
	s := testStore(t)
	first, secret, err := s.Create("Phone reader", time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.Equal(t, "phone-reader", first.Slug)
	assert.Len(t, secret, 51)
	var hash []byte
	require.NoError(t, s.DB.QueryRow(`SELECT token_hash FROM api_tokens WHERE id=?`, first.ID).Scan(&hash))
	digest := sha256.Sum256([]byte(secret))
	assert.Equal(t, digest[:], hash)
	second, secret2, err := s.Create("Phone reader", time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.Equal(t, "phone-reader-2", second.Slug)
	assert.NotEqual(t, secret, secret2)
	items, err := s.List()
	require.NoError(t, err)
	require.Len(t, items, 2)
	valid, err := s.Validate(secret)
	require.NoError(t, err)
	assert.True(t, valid)
	for _, bad := range []string{"", "mynotes_invalid", strings.Repeat("x", 51), secret2[:50] + "!"} {
		valid, err = s.Validate(bad)
		require.NoError(t, err)
		assert.False(t, valid)
	}
	_, err = s.DB.Exec(`UPDATE api_tokens SET expires_at=? WHERE id=?`, time.Now().Add(-time.Second).UTC().Format(time.RFC3339), first.ID)
	require.NoError(t, err)
	valid, err = s.Validate(secret)
	require.NoError(t, err)
	assert.False(t, valid)
	revoked, err := s.Revoke(second.Slug)
	require.NoError(t, err)
	assert.True(t, revoked)
	valid, err = s.Validate(secret2)
	require.NoError(t, err)
	assert.False(t, valid)
	revoked, err = s.Revoke(second.Slug)
	require.NoError(t, err)
	assert.False(t, revoked)
	for _, name := range []string{"", " ", "bad\nname", "bad\u202ename", string([]byte{0xff}), strings.Repeat("a", 201)} {
		_, _, err = s.Create(name, time.Now().Add(time.Hour))
		assert.ErrorIs(t, err, ErrValidation)
	}
	_, _, err = s.Create("Past", time.Now().Add(-time.Second))
	assert.ErrorIs(t, err, ErrValidation)
}

func TestManagementValidation(t *testing.T) {
	s := testStore(t)
	for _, body := range []string{`{}`, `{"name":"ok","expires_at":"invalid"}`, `{"name":"ok","expires_at":"2099-01-01T00:00:00Z","scope":["note:1"]}`, `{"name":"ok","expires_at":"2099-01-01T00:00:00Z"} {}`} {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/tokens", strings.NewReader(body))
		w := httptest.NewRecorder()
		s.Management(w, r)
		assert.Equal(t, 400, w.Code, w.Body.String())
	}
	items, err := s.List()
	require.NoError(t, err)
	assert.Empty(t, items)
}
