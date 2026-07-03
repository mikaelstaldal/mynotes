package service

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mikaelstaldal/mynotes/internal/repository"

	_ "modernc.org/sqlite"
)

func newTestArtifactService(t *testing.T) *ArtifactService {
	t.Helper()
	db, err := sql.Open("sqlite", "file::memory:?cache=shared&_pragma=foreign_keys(on)")
	require.NoError(t, err)
	db.SetMaxOpenConns(1)
	require.NoError(t, repository.InitSchema(db))
	t.Cleanup(func() { _ = db.Close() })
	return NewArtifactService(repository.NewArtifactRepository(db))
}

func TestValidateArtifactContent_Raster(t *testing.T) {
	valid := map[string][]byte{
		"image/png":  {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 1, 2, 3},
		"image/jpeg": {0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3},
		"image/gif":  []byte("GIF89a" + "rest"),
		"image/webp": append([]byte("RIFF"), append([]byte{0, 0, 0, 0}, []byte("WEBPVP8 ")...)...),
	}
	for contentType, content := range valid {
		assert.NoError(t, validateArtifactContent(content, contentType), contentType)
	}

	mismatched := map[string][]byte{
		"image/png":  []byte("not a png"),
		"image/jpeg": []byte("not a jpeg"),
		"image/gif":  []byte("not a gif"),
		"image/webp": []byte("not a webp"),
	}
	for contentType, content := range mismatched {
		err := validateArtifactContent(content, contentType)
		assert.ErrorIs(t, err, ErrValidation, contentType)
	}
}

func TestValidateArtifactContent_XML(t *testing.T) {
	assert.NoError(t, validateArtifactContent([]byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`), "image/svg+xml"))
	assert.NoError(t, validateArtifactContent([]byte(`<math xmlns="http://www.w3.org/1998/Math/MathML"></math>`), "application/mathml+xml"))

	err := validateArtifactContent([]byte(`<html><body>not svg</body></html>`), "image/svg+xml")
	assert.ErrorIs(t, err, ErrValidation)

	err = validateArtifactContent([]byte(`<html><body>not math</body></html>`), "application/mathml+xml")
	assert.ErrorIs(t, err, ErrValidation)

	err = validateArtifactContent([]byte(`not xml at all`), "image/svg+xml")
	assert.ErrorIs(t, err, ErrValidation)

	err = validateArtifactContent([]byte(`<!-- comment --><svg></svg>`), "image/svg+xml")
	assert.NoError(t, err, "leading comment before root element is skipped")
}

func TestArtifactServiceCreate_RejectsMismatchedContent(t *testing.T) {
	svc := newTestArtifactService(t)
	_, err := svc.Create(context.Background(), []byte("this is not a png"), "image/png")
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrValidation))
}

func TestArtifactServiceCreate_AcceptsMatchingContent(t *testing.T) {
	svc := newTestArtifactService(t)
	content := []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	a, err := svc.Create(context.Background(), content, "image/svg+xml")
	require.NoError(t, err)
	assert.Equal(t, "image/svg+xml", a.ContentType)
}
