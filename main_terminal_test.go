package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMarkdownImportEscapesErrorSummary(t *testing.T) {
	// A missing directory produces a path-bearing error before progress starts.
	// The batch summary must escape that error when displaying it.
	path := filepath.Join(t.TempDir(), "missing\x1b]52;c;payload\a\r\u009b\xff")
	reader, writer, err := os.Pipe()
	require.NoError(t, err)
	original := os.Stdout
	os.Stdout = writer
	t.Cleanup(func() {
		os.Stdout = original
		_ = reader.Close()
		_ = writer.Close()
	})
	err = runMarkdownImport(context.Background(), path, t.TempDir())
	os.Stdout = original
	require.NoError(t, writer.Close())
	output, readErr := io.ReadAll(reader)
	require.NoError(t, readErr)
	require.Error(t, err)
	assert.Contains(t, string(output), "1 failed:")
	assert.Contains(t, string(output), `missing\u001b]52;c;payload\u0007\u000d\u009b\xff`)
	for _, c := range []string{"\x1b", "\a", "\r", "\u009b", "\xff"} {
		assert.NotContains(t, string(output), c)
	}
}
