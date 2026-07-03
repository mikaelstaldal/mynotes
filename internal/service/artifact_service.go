package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/xml"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/repository"
)

var sha256HexPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

var (
	pngMagic   = []byte("\x89PNG\r\n\x1a\n")
	jpegMagic  = []byte{0xFF, 0xD8, 0xFF}
	gif87Magic = []byte("GIF87a")
	gif89Magic = []byte("GIF89a")
)

// validateArtifactContent verifies that content actually matches its declared
// contentType, so a stored artifact's Content-Type is a guarantee rather than
// a caller-supplied claim. Raster formats are checked by magic bytes; SVG and
// MathML are checked by parsing as XML and requiring the expected root
// element.
func validateArtifactContent(content []byte, contentType string) error {
	switch contentType {
	case "image/png":
		if !bytes.HasPrefix(content, pngMagic) {
			return validationError("content does not match declared type image/png")
		}
	case "image/jpeg":
		if !bytes.HasPrefix(content, jpegMagic) {
			return validationError("content does not match declared type image/jpeg")
		}
	case "image/gif":
		if !bytes.HasPrefix(content, gif87Magic) && !bytes.HasPrefix(content, gif89Magic) {
			return validationError("content does not match declared type image/gif")
		}
	case "image/webp":
		if len(content) < 12 || !bytes.Equal(content[0:4], []byte("RIFF")) || !bytes.Equal(content[8:12], []byte("WEBP")) {
			return validationError("content does not match declared type image/webp")
		}
	case "image/svg+xml":
		return validateXMLRoot(content, "svg")
	case "application/mathml+xml":
		return validateXMLRoot(content, "math")
	}
	return nil
}

// validateXMLRoot reports a validation error unless content parses as XML
// whose root element local name is expected.
func validateXMLRoot(content []byte, expected string) error {
	dec := xml.NewDecoder(bytes.NewReader(content))
	for {
		tok, err := dec.Token()
		if err != nil {
			return validationError(fmt.Sprintf("content is not well-formed XML with root element <%s>", expected))
		}
		if se, ok := tok.(xml.StartElement); ok {
			if se.Name.Local != expected {
				return validationError(fmt.Sprintf("content root element is <%s>, expected <%s>", se.Name.Local, expected))
			}
			return nil
		}
	}
}

// ArtifactService manages binary artifacts. Content is stored verbatim and
// never mutated; the SHA-256 digest is computed here and used as the key.
type ArtifactService struct {
	repo *repository.ArtifactRepository
}

func NewArtifactService(repo *repository.ArtifactRepository) *ArtifactService {
	return &ArtifactService{repo: repo}
}

// Create computes the SHA-256 of content, stores the artifact (idempotent on
// repeated uploads of the same bytes), and returns the stored record.
func (s *ArtifactService) Create(ctx context.Context, content []byte, contentType string) (model.Artifact, error) {
	if len(content) == 0 {
		return model.Artifact{}, validationError("artifact content must not be empty")
	}
	if contentType == "" || !strings.Contains(contentType, "/") {
		return model.Artifact{}, validationError("invalid content type")
	}
	if err := validateArtifactContent(content, contentType); err != nil {
		return model.Artifact{}, err
	}
	digest := sha256.Sum256(content)
	hex := fmt.Sprintf("%x", digest)
	return s.repo.Create(ctx, hex, content, contentType, time.Now().UTC())
}

// Get returns the artifact identified by its hex SHA-256 digest.
func (s *ArtifactService) Get(ctx context.Context, sha256hex string) (model.Artifact, error) {
	if !sha256HexPattern.MatchString(sha256hex) {
		return model.Artifact{}, ErrNotFound
	}
	return s.repo.GetBySHA256(ctx, sha256hex)
}

// Delete removes the artifact identified by its hex SHA-256 digest.
func (s *ArtifactService) Delete(ctx context.Context, sha256hex string) error {
	if !sha256HexPattern.MatchString(sha256hex) {
		return ErrNotFound
	}
	return s.repo.Delete(ctx, sha256hex)
}
