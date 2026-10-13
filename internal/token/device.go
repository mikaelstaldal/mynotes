package token

import (
	"context"
	"database/sql"
	"fmt"
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
		DB: s.DB, ClientIDs: []string{"mynotes-token"}, VerificationURI: verificationURI, AllowEmptyScope: true,
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
	mux.HandleFunc("POST /api/v1/oauth/device/{user_code}", grant.Approval)
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
