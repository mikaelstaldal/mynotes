package handler_test

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mikaelstaldal/mynotes/internal/api"
)

// TestNoteLinksInGetResponse checks that a note's GET response exposes both link
// directions with slug + title.
func TestNoteLinksInGetResponse(t *testing.T) {
	srv := newServer(t)

	createNote(t, srv, `{"title":"First","slug":"first","content":"go to [[second]]"}`)
	createNote(t, srv, `{"title":"Second","slug":"second","content":"back to [[first]]"}`)

	res, err := http.Get(srv.URL + "/api/v1/notes/first")
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	var got api.Note
	require.NoError(t, json.NewDecoder(res.Body).Decode(&got))

	require.Len(t, got.OutgoingLinks, 1)
	assert.Equal(t, "second", got.OutgoingLinks[0].Slug)
	assert.Equal(t, "Second", got.OutgoingLinks[0].Title)
	require.Len(t, got.IncomingLinks, 1)
	assert.Equal(t, "second", got.IncomingLinks[0].Slug)
	assert.Equal(t, "Second", got.IncomingLinks[0].Title)
}

// TestNoteLinksJSONKeysPresent asserts the fields are always present in the JSON
// (as empty arrays when absent), matching the OpenAPI "required" contract.
func TestNoteLinksJSONKeysPresent(t *testing.T) {
	srv := newServer(t)
	createNote(t, srv, `{"title":"Solo","slug":"solo","content":"no links"}`)

	res, err := http.Get(srv.URL + "/api/v1/notes/solo")
	require.NoError(t, err)
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	require.NoError(t, err)

	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(body, &raw))
	require.Contains(t, raw, "incoming_links")
	require.Contains(t, raw, "outgoing_links")
	assert.JSONEq(t, `[]`, string(raw["incoming_links"]))
	assert.JSONEq(t, `[]`, string(raw["outgoing_links"]))
}

// TestNoteLinksInListResponse checks that list (NoteSummary) responses also
// carry the link fields.
func TestNoteLinksInListResponse(t *testing.T) {
	srv := newServer(t)
	createNote(t, srv, `{"title":"Ay","slug":"ay","content":"see [[bee]]"}`)
	createNote(t, srv, `{"title":"Bee","slug":"bee","content":"plain"}`)

	res, err := http.Get(srv.URL + "/api/v1/notes")
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	var list api.NoteList
	require.NoError(t, json.NewDecoder(res.Body).Decode(&list))

	summaries := map[string]api.NoteSummary{}
	for _, n := range list.Notes {
		summaries[n.Slug] = n
	}
	require.Len(t, summaries["ay"].OutgoingLinks, 1)
	assert.Equal(t, "bee", summaries["ay"].OutgoingLinks[0].Slug)
	require.Len(t, summaries["bee"].IncomingLinks, 1)
	assert.Equal(t, "ay", summaries["bee"].IncomingLinks[0].Slug)
}
