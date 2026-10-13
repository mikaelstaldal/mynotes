package token

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/mikaelstaldal/go-server-common/devicegrant"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDeviceAtomicMintLimitsAndHashStorage(t *testing.T) {
	store := testStore(t)
	grant := store.DeviceGrant("https://example.org/mynotes/device-approval.html")
	now := time.Now().UTC().Truncate(time.Second)
	grant.Now = func() time.Time { return now }
	mux := http.NewServeMux()
	MountDeviceGrant(mux, grant)
	send := func(path, body, content, ip string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Header.Set("Content-Type", content)
		r.RemoteAddr = ip + ":1234"
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	start := func(ip string) *httptest.ResponseRecorder {
		return send("/api/v1/oauth/device_authorization", "client_id=mynotes-token&name=Reader", "application/x-www-form-urlencoded", ip)
	}
	w := start("127.0.0.1")
	require.Equal(t, 200, w.Code)
	var a devicegrant.Authorization
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &a))
	var hash []byte
	require.NoError(t, store.DB.QueryRow(`SELECT device_code_hash FROM device_authorizations`).Scan(&hash))
	assert.Len(t, hash, 32)
	assert.NotEqual(t, []byte(a.DeviceCode), hash)
	for range 2 {
		assert.Equal(t, 200, start("127.0.0.1").Code)
	}
	assert.Equal(t, 429, start("127.0.0.1").Code)
	for i := range 7 {
		assert.Equal(t, 200, start("192.0.2."+string(rune('1'+i))).Code)
	}
	assert.Equal(t, 429, start("127.0.0.2").Code)
	now = now.Add(600 * time.Second)
	w = start("127.0.0.1")
	require.Equal(t, 200, w.Code)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &a))
	w = send("/api/v1/oauth/device/"+a.UserCode, `{"approve":true,"lifetime":"30d"}`, "application/json", "127.0.0.1")
	require.Equal(t, 200, w.Code, w.Body.String())
	mint := grant.Mint
	grant.Mint = func(ctx context.Context, tx *sql.Tx, name string, scope []string, expiry time.Time) (devicegrant.Token, error) {
		_, err := mint(ctx, tx, name, scope, expiry)
		require.NoError(t, err)
		return devicegrant.Token{}, errors.New("injected mint failure")
	}
	poll := func() *httptest.ResponseRecorder {
		return send("/api/v1/oauth/token", url.Values{"client_id": {"mynotes-token"}, "grant_type": {devicegrant.GrantType}, "device_code": {a.DeviceCode}}.Encode(), "application/x-www-form-urlencoded", "127.0.0.1")
	}
	assert.Equal(t, 500, poll().Code)
	var count int
	require.NoError(t, store.DB.QueryRow(`SELECT count(*) FROM api_tokens`).Scan(&count))
	assert.Zero(t, count)
	require.NoError(t, store.DB.QueryRow(`SELECT count(*) FROM device_authorizations WHERE status='approved'`).Scan(&count))
	assert.Equal(t, 1, count)
	grant.Mint = mint
	// Concurrent exchanges serialize at the SQLite lock; only one returns a secret.
	results := make(chan int, 4)
	for range 4 {
		go func() { results <- poll().Code }()
	}
	successes := 0
	for range 4 {
		if status := <-results; status == 200 {
			successes++
		} else {
			assert.Equal(t, 400, status)
		}
	}
	assert.Equal(t, 1, successes)
	require.NoError(t, store.DB.QueryRow(`SELECT count(*) FROM api_tokens`).Scan(&count))
	assert.Equal(t, 1, count)
	require.NoError(t, store.DB.QueryRow(`SELECT count(*) FROM device_authorizations`).Scan(&count))
	assert.Zero(t, count)
}
