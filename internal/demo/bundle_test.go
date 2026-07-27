package demo

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The seed is what the browser demo starts from, so it has to carry the same
// content -demo writes into SQLite — it is produced by running that same
// seeding code against a throwaway in-memory database.
func TestBuildSeed(t *testing.T) {
	seed, err := BuildSeed(context.Background())
	require.NoError(t, err)

	assert.Len(t, seed.Tags, len(demoTags))
	assert.Len(t, seed.Notes, 6)
	assert.Len(t, seed.Artifacts, 3)

	slugs := make([]string, len(seed.Notes))
	for i, n := range seed.Notes {
		slugs[i] = n.Slug
		assert.NotEmpty(t, n.Title, n.Slug)
		assert.NotEmpty(t, n.Content, n.Slug)
		assert.Equal(t, 1, n.Version, n.Slug)
		assert.NotEmpty(t, n.CreatedAt, n.Slug)
		assert.NotEmpty(t, n.UpdatedAt, n.Slug)
		assert.NotNil(t, n.Tags, "tags must marshal as [] rather than null")
	}
	assert.Contains(t, slugs, "welcome-to-mynotes")

	// Every note tag must name a tag in the seed, or the demo would reject the
	// note the first time it is edited.
	known := make(map[string]bool, len(seed.Tags))
	for _, tag := range seed.Tags {
		known[tag.Slug] = true
	}
	for _, n := range seed.Notes {
		for _, tag := range n.Tags {
			assert.True(t, known[tag], "note %q carries unknown tag %q", n.Slug, tag)
		}
	}

	// Artifacts are referenced from note content by digest, so the bytes have to
	// arrive intact and under the digest the content points at.
	for _, a := range seed.Artifacts {
		content, err := base64.StdEncoding.DecodeString(a.Data)
		require.NoError(t, err, a.SHA256)
		assert.NotEmpty(t, content)
		assert.NotEmpty(t, a.ContentType)
		referenced := false
		for _, n := range seed.Notes {
			if strings.Contains(n.Content, a.SHA256) {
				referenced = true
				break
			}
		}
		assert.True(t, referenced, "artifact %s is not referenced by any note", a.SHA256)
	}

	// The worker rebuilds icon SVGs from this bundle (mirroring internal/icons),
	// and resolves it relative to the deployment root.
	assert.True(t, strings.HasPrefix(seed.LucideBundle, "vendor/lucide-"), seed.LucideBundle)
	assert.True(t, strings.HasSuffix(seed.LucideBundle, ".js"), seed.LucideBundle)
}

// BuildSeed opens a private database each time, so repeated calls neither
// interfere nor accumulate.
func TestBuildSeedIsRepeatable(t *testing.T) {
	first, err := BuildSeedJSON(context.Background())
	require.NoError(t, err)
	second, err := BuildSeedJSON(context.Background())
	require.NoError(t, err)

	var a, b Seed
	require.NoError(t, json.Unmarshal(first, &a))
	require.NoError(t, json.Unmarshal(second, &b))
	assert.Len(t, b.Notes, len(a.Notes))
	assert.Len(t, b.Tags, len(a.Tags))
	assert.Len(t, b.Artifacts, len(a.Artifacts))
}
