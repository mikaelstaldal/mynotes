package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mikaelstaldal/go-server-common/devicegrant"
	"github.com/mikaelstaldal/go-server-common/hostguard"
	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDeviceLoginFullStack(t *testing.T) {
	db, err := repository.OpenDB(t.TempDir()+"/app.sqlite", 5000)
	require.NoError(t, err)
	defer db.Close()
	store := &token.Store{DB: db}
	now := time.Now().UTC().Truncate(time.Second)
	grant := store.DeviceGrant(token.DeviceVerificationURI("http://localhost:8080", "127.0.0.1", 8080))
	grant.Now = func() time.Time { return now }
	mux := http.NewServeMux()
	token.MountDeviceGrant(mux, grant)
	mux.HandleFunc("GET /api/v1/notes", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"items":[]}`)) })
	authFile := filepath.Join(t.TempDir(), "htpasswd")
	require.NoError(t, os.WriteFile(authFile, []byte("alice:$2y$05$YjuAjU9iJvJ8KhdNm5UFSurCx2d/Y4BqmPeg/3t1ybsqlysbbwtQ6\n"), 0600))
	policy, err := hostguard.New("http://localhost:8080", "127.0.0.1", 8080)
	require.NoError(t, err)
	h, err := serverMiddleware(mux, policy, "http://localhost:8080", authFile, "MyNotes", "default-src 'self'", store)
	require.NoError(t, err)
	send := func(method, path, body, content, credentials, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost:8080"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", content)
		r.Header.Set("User-Agent", "mynotes-token test")
		if credentials == "basic" {
			r.SetBasicAuth("alice", "s3cret")
		} else if credentials != "" {
			r.Header.Set("Authorization", "Bearer "+credentials)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	start := func() devicegrant.Authorization {
		w := send("POST", "/api/v1/oauth/device_authorization", url.Values{"client_id": {"mynotes-token"}, "name": {"Reader"}, "lifetime": {"7d"}}.Encode(), "application/x-www-form-urlencoded", "", "")
		require.Equal(t, 200, w.Code, w.Body.String())
		var a devicegrant.Authorization
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &a))
		return a
	}
	poll := func(a devicegrant.Authorization) *httptest.ResponseRecorder {
		return send("POST", "/api/v1/oauth/token", url.Values{"client_id": {"mynotes-token"}, "grant_type": {devicegrant.GrantType}, "device_code": {a.DeviceCode}}.Encode(), "application/x-www-form-urlencoded", "", "")
	}
	assert.Equal(t, 401, send("POST", "/api/v1/oauth%2Ftoken", "grant_type=x", "application/x-www-form-urlencoded", "", "").Code)
	for _, scope := range []string{"note:1", "tag:private", "*", "read"} {
		w := send("POST", "/api/v1/oauth/device_authorization", url.Values{"client_id": {"mynotes-token"}, "name": {"Reader"}, "scope": {scope}}.Encode(), "application/x-www-form-urlencoded", "", "")
		assert.Equal(t, 400, w.Code)
		assert.Contains(t, w.Body.String(), "invalid_scope")
	}
	a := start()
	approval := "/api/v1/oauth/device/" + a.UserCode
	assert.Equal(t, 401, send("GET", approval, "", "", "", "").Code)
	assert.Equal(t, 401, send("POST", approval, `{"approve":false}`, "application/json", "", "").Code)
	w := send("GET", approval, "", "", "basic", "")
	require.Equal(t, 200, w.Code, w.Body.String())
	var pending devicegrant.Request
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &pending))
	assert.Empty(t, pending.Scope)
	assert.Equal(t, "7d", pending.Lifetime)
	assert.Contains(t, pending.Requester, "mynotes-token test")
	assert.Contains(t, poll(a).Body.String(), "authorization_pending")
	assert.Contains(t, poll(a).Body.String(), "slow_down")
	assert.Equal(t, 403, send("POST", approval, `{"approve":false}`, "application/json", "basic", "http://evil.test").Code)
	assert.Equal(t, 400, send("POST", approval, `{"approve":true,"scope":["note:1"],"lifetime":"1d"}`, "application/json", "basic", "").Code)
	w = send("POST", approval, `{"approve":true,"scope":[],"lifetime":"1d"}`, "application/json", "basic", "http://localhost:8080")
	require.Equal(t, 200, w.Code, w.Body.String())
	assert.Equal(t, 404, send("POST", approval, `{"approve":false}`, "application/json", "basic", "").Code)
	now = now.Add(10 * time.Second)
	w = poll(a)
	require.Equal(t, 200, w.Code, w.Body.String())
	var issued devicegrant.Token
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &issued))
	assert.NotEmpty(t, issued.Slug)
	assert.Empty(t, issued.Scope)
	assert.Equal(t, "Bearer", issued.TokenType)
	assert.Contains(t, poll(a).Body.String(), "invalid_grant")
	valid, err := store.Validate(issued.AccessToken)
	require.NoError(t, err)
	assert.True(t, valid)
	assert.Equal(t, 200, send("GET", "/api/v1/notes", "", "", issued.AccessToken, "").Code)
	for _, route := range []struct{ method, path string }{{"POST", "/api/v1/oauth/device_authorization"}, {"POST", "/api/v1/oauth/token"}, {"GET", approval}, {"HEAD", approval}, {"POST", approval}} {
		assert.Equal(t, 403, send(route.method, route.path, `{}`, "application/json", issued.AccessToken, "").Code)
	}
	denied := start()
	assert.Equal(t, 200, send("POST", "/api/v1/oauth/device/"+denied.UserCode, `{"approve":false}`, "application/json", "basic", "").Code)
	assert.Contains(t, poll(denied).Body.String(), "access_denied")
	assert.Contains(t, poll(denied).Body.String(), "invalid_grant")
	expired := start()
	now = now.Add(600 * time.Second)
	assert.Contains(t, poll(expired).Body.String(), "expired_token")
	assert.Equal(t, 404, send("GET", "/api/v1/oauth/device/"+expired.UserCode, "", "", "basic", "").Code)
	// Public protocol still has Host, CSRF, body limits and no bearer bypass.
	assert.Equal(t, 403, send("POST", "/api/v1/oauth/device_authorization", "client_id=mynotes-token&name=x", "application/x-www-form-urlencoded", "", "http://evil.test").Code)
	r := httptest.NewRequest("POST", "http://foreign.test/api/v1/oauth/device_authorization", strings.NewReader("client_id=mynotes-token&name=x"))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	assert.Equal(t, 421, w.Code)
	assert.Equal(t, 400, send("POST", "/api/v1/oauth/device_authorization", "client_id=mynotes-token&name="+strings.Repeat("x", 8192), "application/x-www-form-urlencoded", "", "").Code)
}
