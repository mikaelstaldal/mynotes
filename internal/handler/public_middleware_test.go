package handler_test

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/mikaelstaldal/mynotes/internal/handler"
	"github.com/stretchr/testify/assert"
)

func TestPublicMiddlewareLimitsAcrossRoutesAndReleasesSlots(t *testing.T) {
	wrap := handler.PublicMiddleware()
	entered := make(chan struct{}, 16)
	release := make(chan struct{})
	slow := wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { entered <- struct{}{}; <-release }))
	var workers sync.WaitGroup
	for range 16 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			slow.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/public/notes/a", nil))
		}()
	}
	for range 16 {
		<-entered
	}
	other := wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	busy := httptest.NewRecorder()
	other.ServeHTTP(busy, httptest.NewRequest("GET", "/public/artifacts/a", nil))
	assert.Equal(t, http.StatusServiceUnavailable, busy.Code)
	assert.Equal(t, "no-store", busy.Header().Get("Cache-Control"))
	close(release)
	workers.Wait()
	available := httptest.NewRecorder()
	other.ServeHTTP(available, httptest.NewRequest("GET", "/public/artifacts/a", nil))
	assert.Equal(t, http.StatusNoContent, available.Code)
}
