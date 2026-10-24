package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTerminalErrorProcess(t *testing.T) {
	if os.Getenv("MYNOTES_TEST_ERROR_PROCESS") != "1" {
		return
	}
	require.NoError(t, json.Unmarshal([]byte(os.Getenv("MYNOTES_TEST_ARGS")), &os.Args))
	main()
}

func TestTerminalErrors(t *testing.T) {
	payload := "\x1b]52;c;payload\a\r\u009b"
	for _, mode := range []string{"create", "revoke", "authorization", "poll"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "poll" && strings.HasSuffix(r.URL.Path, "/device_authorization") {
					_ = json.NewEncoder(w).Encode(map[string]any{
						"device_code": "device", "user_code": "CODE", "verification_uri": "https://example.org",
						"expires_in": 10, "interval": 1,
					})
					return
				}
				w.WriteHeader(http.StatusBadRequest)
				if mode == "authorization" || mode == "poll" {
					_ = json.NewEncoder(w).Encode(map[string]string{"error": payload})
				} else {
					_, _ = w.Write([]byte(payload + "\xff"))
				}
			}))
			defer server.Close()
			args := []string{"mynotes-token", "-url", server.URL}
			switch mode {
			case "create":
				args = append(args, "create", "-name", "reader", "-lifetime", "1d")
			case "revoke":
				args = append(args, "revoke", "reader")
			default:
				args = append(args, "login", "-name", "reader")
			}
			encoded, err := json.Marshal(args)
			require.NoError(t, err)
			command := exec.Command(os.Args[0], "-test.run=^TestTerminalErrorProcess$")
			command.Env = append(os.Environ(), "MYNOTES_TEST_ERROR_PROCESS=1", "MYNOTES_TEST_ARGS="+string(encoded), "MYNOTES_USER=")
			var stderr bytes.Buffer
			command.Stderr = &stderr
			require.Error(t, command.Run())
			assert.Contains(t, stderr.String(), "mynotes-token:")
			assert.Contains(t, stderr.String(), `\u001b]52;c;payload\u0007\u000d\u009b`)
			for _, c := range []string{"\x1b", "\a", "\r", "\u009b", "\xff"} {
				assert.NotContains(t, stderr.String(), c)
			}
		})
	}
}
