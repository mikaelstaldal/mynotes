package gdocs

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/oauth2"
)

const (
	driveFilesURL = "https://www.googleapis.com/drive/v3/files"
	maxExportSize = 10 << 20 // 10 MiB
)

// DriveFile holds metadata for a Google Doc.
type DriveFile struct {
	ID           string
	Name         string
	CreatedTime  time.Time
	ModifiedTime time.Time
}

// Client is an authenticated Google Drive API v3 client.
type Client struct {
	http *http.Client
}

// NewClient creates a Drive client using the provided OAuth2 token.
func NewClient(ctx context.Context, cfg *oauth2.Config, tok *oauth2.Token) *Client {
	return &Client{http: cfg.Client(ctx, tok)}
}

// ListOwnedDocs returns all owned Google Docs (not Sheets, Slides, or Forms)
// that are not trashed, paging through all results automatically.
func (c *Client) ListOwnedDocs(ctx context.Context) ([]DriveFile, error) {
	var files []DriveFile
	pageToken := ""
	for {
		params := url.Values{
			"q":        {`'me' in owners and mimeType='application/vnd.google-apps.document' and trashed=false`},
			"fields":   {"nextPageToken,files(id,name,createdTime,modifiedTime)"},
			"pageSize": {"1000"},
			"orderBy":  {"modifiedTime desc"},
		}
		if pageToken != "" {
			params.Set("pageToken", pageToken)
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			driveFilesURL+"?"+params.Encode(), nil)
		if err != nil {
			return nil, err
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return nil, fmt.Errorf("list docs: %w", err)
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxExportSize))
		_ = resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("read list response: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("list docs: HTTP %d: %s", resp.StatusCode, body)
		}

		var page struct {
			NextPageToken string `json:"nextPageToken"`
			Files         []struct {
				ID           string `json:"id"`
				Name         string `json:"name"`
				CreatedTime  string `json:"createdTime"`
				ModifiedTime string `json:"modifiedTime"`
			} `json:"files"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("parse list response: %w", err)
		}
		for _, f := range page.Files {
			ct, _ := time.Parse(time.RFC3339, f.CreatedTime)
			mt, _ := time.Parse(time.RFC3339, f.ModifiedTime)
			files = append(files, DriveFile{
				ID:           f.ID,
				Name:         f.Name,
				CreatedTime:  ct,
				ModifiedTime: mt,
			})
		}
		if page.NextPageToken == "" {
			break
		}
		pageToken = page.NextPageToken
	}
	return files, nil
}

// ExportDoc exports a Google Doc as Markdown (preferred) or HTML (fallback).
// Returns (content, isHTML, error).
func (c *Client) ExportDoc(ctx context.Context, fileID string) (string, bool, error) {
	content, err := c.exportAs(ctx, fileID, "text/markdown")
	if err == nil {
		return content, false, nil
	}
	content, err = c.exportAs(ctx, fileID, "text/html")
	if err != nil {
		return "", false, err
	}
	return content, true, nil
}

func (c *Client) exportAs(ctx context.Context, fileID, mimeType string) (string, error) {
	params := url.Values{"mimeType": {mimeType}}
	exportURL := fmt.Sprintf("%s/%s/export?%s", driveFilesURL, url.PathEscape(fileID), params.Encode())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, exportURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxExportSize))
	_ = resp.Body.Close()
	if err != nil {
		return "", fmt.Errorf("read export: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("export as %s: HTTP %d", mimeType, resp.StatusCode)
	}
	return string(body), nil
}
