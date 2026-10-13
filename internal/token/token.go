package token

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Store keeps only a SHA-256 digest of each random, 256-bit bearer secret.
type Store struct{ DB *sql.DB }

type Record struct {
	ID        int64  `json:"-"`
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
}

var ErrValidation = errors.New("invalid token request")

func invalid(message string) error { return fmt.Errorf("%w: %s", ErrValidation, message) }

func (s Store) Create(name string, expiry time.Time) (Record, string, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return Record{}, "", err
	}
	defer tx.Rollback()
	record, value, err := s.createTx(tx, name, expiry)
	if err != nil {
		return Record{}, "", err
	}
	if err := tx.Commit(); err != nil {
		return Record{}, "", err
	}
	return record, value, nil
}

// createTx is shared by interactive issuance and the atomic device grant exchange.
func (s Store) createTx(tx *sql.Tx, name string, expiry time.Time) (Record, string, error) {
	var record Record
	var err error
	if strings.TrimSpace(name) == "" || len(name) > 200 || !expiry.Truncate(time.Second).After(time.Now()) || !utf8.ValidString(name) || strings.IndexFunc(name, func(c rune) bool { return unicode.IsControl(c) || unicode.Is(unicode.Cf, c) }) >= 0 {
		return record, "", invalid("name and future expiry are required")
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return record, "", err
	}
	value := "mynotes_" + base64.RawURLEncoding.EncodeToString(secret)
	digest := sha256.Sum256([]byte(value))
	record = Record{Name: strings.TrimSpace(name), CreatedAt: time.Now().UTC().Format(time.RFC3339), ExpiresAt: expiry.UTC().Format(time.RFC3339)}
	if _, err := tx.Exec(`DELETE FROM api_tokens WHERE expires_at <= ?`, record.CreatedAt); err != nil {
		return Record{}, "", err
	}
	base := slugify(record.Name)
	for number := 1; ; number++ {
		record.Slug = slugCandidate(base, number)
		err = tx.QueryRow(`INSERT INTO api_tokens(name,slug,token_hash,created_at,expires_at)
			VALUES(?,?,?,?,?) ON CONFLICT(slug) DO NOTHING RETURNING id`,
			record.Name, record.Slug, digest[:], record.CreatedAt, record.ExpiresAt).Scan(&record.ID)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return Record{}, "", err
		}
		break
	}
	return record, value, nil
}

func (s Store) List() ([]Record, error) {
	rows, err := s.DB.Query(`SELECT id,slug,name,created_at,expires_at FROM api_tokens ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Record{}
	for rows.Next() {
		var r Record
		if err := rows.Scan(&r.ID, &r.Slug, &r.Name, &r.CreatedAt, &r.ExpiresAt); err != nil {
			return nil, err
		}
		items = append(items, r)
	}
	return items, rows.Err()
}

func (s Store) Revoke(slug string) (bool, error) {
	res, err := s.DB.Exec(`DELETE FROM api_tokens WHERE slug=?`, slug)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// Validate checks the hash and expiry; secrets are never stored.
func (s Store) Validate(value string) (bool, error) {
	if !strings.HasPrefix(value, "mynotes_") || len(value) != 51 {
		return false, nil
	}
	digest := sha256.Sum256([]byte(value))
	var expiry string
	err := s.DB.QueryRowContext(context.Background(), `SELECT expires_at FROM api_tokens WHERE token_hash=?`, digest[:]).Scan(&expiry)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	until, err := time.Parse(time.RFC3339, expiry)
	return err == nil && time.Now().Before(until), err
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

var slugPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// Management permits only the full-access caller. The outer Basic middleware
// authenticates it when Basic auth is configured.
func (s Store) Management(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/api/v1/tokens" {
		switch r.Method {
		case http.MethodGet:
			items, err := s.List()
			if err != nil {
				writeError(w, 500, "database error")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"total": len(items), "items": items})
		case http.MethodPost:
			var input struct {
				Name      string `json:"name"`
				ExpiresAt string `json:"expires_at"`
			}
			r.Body = http.MaxBytesReader(w, r.Body, 8192)
			dec := json.NewDecoder(r.Body)
			dec.DisallowUnknownFields()
			if err := dec.Decode(&input); err != nil {
				writeError(w, 400, "invalid token request")
				return
			}
			if err := dec.Decode(new(any)); err != io.EOF {
				writeError(w, 400, "invalid token request")
				return
			}
			expiry, err := time.Parse(time.RFC3339, input.ExpiresAt)
			if err != nil {
				writeError(w, 400, "invalid expiry")
				return
			}
			record, value, err := s.Create(input.Name, expiry)
			if err != nil {
				if errors.Is(err, ErrValidation) {
					writeError(w, 400, err.Error())
				} else {
					writeError(w, 500, "database error")
				}
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(struct {
				Record
				Token string `json:"token"`
			}{record, value})
		default:
			writeError(w, 405, "method not allowed")
		}
		return
	}
	if r.Method != http.MethodDelete {
		writeError(w, 405, "method not allowed")
		return
	}
	slug := strings.TrimPrefix(r.URL.Path, "/api/v1/tokens/")
	if !slugPattern.MatchString(slug) {
		writeError(w, 404, "token not found")
		return
	}
	ok, err := s.Revoke(slug)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	if !ok {
		writeError(w, 404, "token not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func slugify(name string) string {
	s := regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(norm.NFKD.String(name)), "-")
	s = strings.Trim(s, "-")
	// NFKD can expand a 200-byte name into a much longer ASCII slug.
	// Reserve 20 characters for the collision suffix within the API limit.
	if len(s) > 200 {
		s = strings.TrimRight(s[:200], "-")
	}
	if s == "" {
		s = "token"
	}
	return s
}
func slugCandidate(base string, number int) string {
	if number == 1 {
		return base
	}
	return fmt.Sprintf("%s-%d", base, number)
}
