// Package gdocs provides a batch importer for Google Docs via the Drive API.
package gdocs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

const driveReadonlyScope = "https://www.googleapis.com/auth/drive.readonly"

// MakeConfig returns an OAuth2 config for Drive readonly access.
// RedirectURL is set dynamically during the loopback flow.
func MakeConfig(clientID, clientSecret string) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Scopes:       []string{driveReadonlyScope},
		Endpoint:     google.Endpoint,
	}
}

// Authenticate returns a valid token, loading from tokenPath when possible,
// or running an interactive loopback OAuth flow on first use. callbackPort
// sets the local port for the OAuth redirect; 0 picks a random free port.
func Authenticate(ctx context.Context, cfg *oauth2.Config, tokenPath string, callbackPort int) (*oauth2.Token, error) {
	if tok, err := loadToken(tokenPath); err == nil {
		ts := cfg.TokenSource(ctx, tok)
		fresh, err := ts.Token()
		if err == nil {
			if fresh.AccessToken != tok.AccessToken {
				_ = saveToken(tokenPath, fresh)
			}
			return fresh, nil
		}
		// Refresh failed — fall through to interactive flow.
	}
	return runOAuthFlow(ctx, cfg, tokenPath, callbackPort)
}

func loadToken(path string) (*oauth2.Token, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var tok oauth2.Token
	if err := json.Unmarshal(data, &tok); err != nil {
		return nil, err
	}
	return &tok, nil
}

func saveToken(path string, tok *oauth2.Token) error {
	data, err := json.Marshal(tok)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

func runOAuthFlow(ctx context.Context, cfg *oauth2.Config, tokenPath string, callbackPort int) (*oauth2.Token, error) {
	addr := fmt.Sprintf("localhost:%d", callbackPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("start OAuth callback listener: %w", err)
	}
	defer func() { _ = ln.Close() }()

	port := ln.Addr().(*net.TCPAddr).Port
	cfg.RedirectURL = fmt.Sprintf("http://localhost:%d/callback", port)

	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return nil, fmt.Errorf("generate OAuth state: %w", err)
	}
	state := hex.EncodeToString(stateBytes)

	authURL := cfg.AuthCodeURL(state, oauth2.AccessTypeOffline)
	fmt.Printf("Opening browser for Google authorization...\nIf the browser does not open, visit:\n  %s\n\n", authURL)
	_ = openBrowser(authURL)

	type result struct {
		code string
		err  error
	}
	ch := make(chan result, 1)

	srv := &http.Server{
		ReadHeaderTimeout: 2 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			q := r.URL.Query()
			if q.Get("state") != state {
				http.Error(w, "invalid state", http.StatusBadRequest)
				ch <- result{err: fmt.Errorf("OAuth state mismatch")}
				return
			}
			if errParam := q.Get("error"); errParam != "" {
				http.Error(w, "authorization denied: "+errParam, http.StatusForbidden)
				ch <- result{err: fmt.Errorf("authorization denied: %s", errParam)}
				return
			}
			_, _ = fmt.Fprintln(w, "Authorization successful! You may close this tab.")
			ch <- result{code: q.Get("code")}
		}),
	}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			select {
			case ch <- result{err: fmt.Errorf("OAuth listener: %w", err)}:
			default:
			}
		}
	}()

	select {
	case res := <-ch:
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		if res.err != nil {
			return nil, res.err
		}
		tok, err := cfg.Exchange(ctx, res.code)
		if err != nil {
			return nil, fmt.Errorf("exchange OAuth code: %w", err)
		}
		if err := saveToken(tokenPath, tok); err != nil {
			fmt.Printf("warning: could not save token to %s: %v\n", tokenPath, err)
		}
		return tok, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func openBrowser(url string) error {
	var cmd string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
	case "windows":
		cmd = "start"
	default:
		cmd = "xdg-open"
	}
	return exec.Command(cmd, url).Start()
}
