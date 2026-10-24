package gdocs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestRunEscapesTerminalProgress(t *testing.T) {
	payload := "\x1b]52;c;payload\a\r\u009b"
	drive := &Client{http: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		status := http.StatusOK
		var body string
		if strings.HasSuffix(r.URL.Path, "/files") {
			data, err := json.Marshal(map[string]any{"files": []map[string]string{{"id": "doc", "name": payload}}})
			require.NoError(t, err)
			body = string(data)
		} else {
			return nil, errors.New(payload + "\xff")
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}}
	var out bytes.Buffer
	imported, errs := Run(context.Background(), drive, nil, &out)
	assert.Zero(t, imported)
	require.Len(t, errs, 1)
	assert.Contains(t, out.String(), `✗ \u001b]52;c;payload\u0007\u000d\u009b`)
	assert.Contains(t, out.String(), `\xff`)
	for _, c := range []string{"\x1b", "\a", "\r", "\u009b", "\xff"} {
		assert.NotContains(t, out.String(), c)
	}
}
