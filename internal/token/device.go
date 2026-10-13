package token

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/mikaelstaldal/go-server-common/devicegrant"
)

// DeviceGrant shares issuance with direct creation; Mint writes through the
// grant transaction so token issuance and grant consumption are atomic.
func (s Store) DeviceGrant(verificationURI string) *devicegrant.Server {
	return &devicegrant.Server{
		DB: s.DB, ClientIDs: []string{"mynotes-token"}, VerificationURI: verificationURI,
		ValidateScope: func(ctx context.Context, tx *sql.Tx, scope []string) error {
			if len(scope) != 0 {
				return fmt.Errorf("MyNotes does not support resource scopes")
			}
			return nil
		},
		Mint: func(ctx context.Context, tx *sql.Tx, name string, scope []string, expiry time.Time) (devicegrant.Token, error) {
			if len(scope) != 0 {
				return devicegrant.Token{}, fmt.Errorf("MyNotes does not support resource scopes")
			}
			record, value, err := s.createTx(tx, name, expiry)
			return devicegrant.Token{AccessToken: value, Slug: record.Slug}, err
		},
	}
}

// DeviceVerificationURI derives deployment URLs from config, never request Host.
func DeviceVerificationURI(publicURL, addr string, port int) string {
	if publicURL == "" {
		publicURL = "http://" + net.JoinHostPort(addr, strconv.Itoa(port))
	}
	u, err := url.Parse(publicURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/device-approval.html"
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

func MountDeviceGrant(mux *http.ServeMux, grant *devicegrant.Server) {
	mux.HandleFunc("POST /api/v1/oauth/device_authorization", grant.Authorize)
	mux.HandleFunc("POST /api/v1/oauth/token", grant.Poll)
	mux.HandleFunc("GET /api/v1/oauth/device/{user_code}", grant.Approval)
	mux.HandleFunc("POST /api/v1/oauth/device/{user_code}", func(w http.ResponseWriter, r *http.Request) { unscopedApproval(grant, w, r) })
}

func IsDeviceEndpoint(r *http.Request) bool {
	return r.URL.RawPath == "" && r.Method == http.MethodPost && (r.URL.Path == "/api/v1/oauth/device_authorization" || r.URL.Path == "/api/v1/oauth/token")
}

// The two CLI protocol endpoints bypass Basic, but retain outer Host, CSRF and
// body-size middleware. Bearer requests never enter this public path.
func PublicDeviceAccess(full, public http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !IsDeviceEndpoint(r) {
			full.ServeHTTP(w, r)
			return
		}
		scheme, _, _ := strings.Cut(r.Header.Get("Authorization"), " ")
		if strings.EqualFold(scheme, "Bearer") {
			writeError(w, 403, "token cannot access this resource")
			return
		}
		public.ServeHTTP(w, r)
	})
}

// unscopedApproval adapts only consent for the app's whole-API access model.
// devicegrant v1.13.2 requires at least one resource scope in Approval, whereas
// MyNotes has no resource scopes. GET, authorization, polling, limits and the
// atomic exchange use the shared server directly. Remove this adapter when the
// shared server supports opting into empty consent scopes.
func unscopedApproval(grant *devicegrant.Server, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	code, ok := devicegrant.NormalizeUserCode(r.PathValue("user_code"))
	if !ok {
		writeError(w, 404, "not_found")
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		writeError(w, 400, "invalid_request")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	var input struct {
		Approve  *bool    `json:"approve"`
		Scope    []string `json:"scope"`
		Lifetime string   `json:"lifetime"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || input.Approve == nil || decoder.Decode(new(any)) != io.EOF {
		writeError(w, 400, "invalid_request")
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	if grant.Now != nil {
		now = grant.Now().UTC().Truncate(time.Second)
	}
	status, expiry := "denied", ""
	if *input.Approve {
		duration, err := devicegrant.ParseLifetime(input.Lifetime)
		if err != nil || len(input.Scope) != 0 {
			writeError(w, 400, "invalid_request")
			return
		}
		status = "approved"
		expiry = now.Add(duration).Format(time.RFC3339)
	}
	tx, err := grant.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, 500, "server_error")
		return
	}
	defer tx.Rollback()
	// Acquire the SQLite write lock before checking pending status, matching the
	// shared server. Consent cannot be replaced by a concurrent approval or poll.
	_, err = tx.ExecContext(r.Context(), `UPDATE device_authorizations SET interval=interval WHERE user_code=?`, code)
	if err != nil {
		writeError(w, 500, "server_error")
		return
	}
	var pending int
	err = tx.QueryRowContext(r.Context(), `SELECT 1 FROM device_authorizations WHERE user_code=? AND status='pending' AND expires_at>?`, code, now.Format(time.RFC3339)).Scan(&pending)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, 404, "not_found")
		return
	}
	if err != nil {
		writeError(w, 500, "server_error")
		return
	}
	if *input.Approve && (grant.ValidateScope == nil || grant.ValidateScope(r.Context(), tx, input.Scope) != nil) {
		writeError(w, 400, "invalid_request")
		return
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE device_authorizations SET status=?,granted_scope='',granted_expiry=? WHERE user_code=?`, status, expiry, code)
	if err != nil {
		writeError(w, 500, "server_error")
		return
	}
	if err = tx.Commit(); err != nil {
		writeError(w, 500, "server_error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"approved": *input.Approve})
}
