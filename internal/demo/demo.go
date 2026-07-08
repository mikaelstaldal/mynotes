// Package demo seeds the database with a curated set of tags, artifacts, and
// notes that exercise MyNotes' feature set — Markdown formatting, tables, code,
// embedded images (as content-addressed artifacts), inline SVG and MathML, and
// tag-based organization. It is invoked as a one-shot batch mode (the -demo
// flag) that populates the store and exits, mirroring the Google Docs importer.
package demo

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"

	"github.com/mikaelstaldal/mynotes/internal/service"
)

// seeder bundles the three services the demo writes through. Every write goes
// through the normal service layer, so demo data is validated exactly like data
// created via the REST API.
type seeder struct {
	notes     *service.NoteService
	artifacts *service.ArtifactService
	tags      *service.TagService
	w         io.Writer
}

// Run populates the store with demo data, writing progress to w. It returns the
// first error encountered (fail-fast: the demo content is fixed and valid, so an
// error signals a genuine problem rather than a single bad record to skip).
func Run(ctx context.Context, notes *service.NoteService, artifacts *service.ArtifactService, tags *service.TagService, w io.Writer) error {
	s := &seeder{notes: notes, artifacts: artifacts, tags: tags, w: w}

	_, _ = fmt.Fprintln(w, "Seeding demo data...")

	// --- tags --------------------------------------------------------------
	for _, slug := range demoTags {
		if err := s.tag(ctx, slug); err != nil {
			return fmt.Errorf("create tag %q: %w", slug, err)
		}
	}
	_, _ = fmt.Fprintf(w, "Created %d tag(s).\n", len(demoTags))

	// --- artifacts ---------------------------------------------------------
	chartPNG, err := barChartPNG()
	if err != nil {
		return fmt.Errorf("render chart image: %w", err)
	}
	chartSHA, err := s.artifact(ctx, chartPNG, "image/png")
	if err != nil {
		return fmt.Errorf("store chart image: %w", err)
	}

	gradientPNG, err := gradientPNG()
	if err != nil {
		return fmt.Errorf("render gradient image: %w", err)
	}
	gradientSHA, err := s.artifact(ctx, gradientPNG, "image/png")
	if err != nil {
		return fmt.Errorf("store gradient image: %w", err)
	}

	logoSVG := []byte(logoSVGSource)
	logoSHA, err := s.artifact(ctx, logoSVG, "image/svg+xml")
	if err != nil {
		return fmt.Errorf("store logo image: %w", err)
	}
	_, _ = fmt.Fprintln(w, "Created 3 artifact(s).")

	// --- notes -------------------------------------------------------------
	// Each entry references its tags by slug (created above). Image references
	// point at the artifacts by SHA.
	notesToCreate := []struct {
		title   string
		content string
		tags    []string
	}{
		{
			title:   "Welcome to MyNotes",
			content: fmt.Sprintf(welcomeNote, logoSHA),
			tags:    []string{"getting-started"},
		},
		{
			title:   "Markdown Formatting Guide",
			content: markdownGuideNote,
			tags:    []string{"getting-started", "reference"},
		},
		{
			title:   "Sourdough Bread",
			content: fmt.Sprintf(recipeNote, gradientSHA),
			tags:    []string{"recipes", "personal"},
		},
		{
			title:   "Q3 Project Roadmap",
			content: fmt.Sprintf(roadmapNote, chartSHA),
			tags:    []string{"work", "reference"},
		},
		{
			title:   "Weekend in Lisbon",
			content: travelNote,
			tags:    []string{"travel", "personal"},
		},
		{
			title:   "Math & Diagrams",
			content: mathNote,
			tags:    []string{"reference"},
		},
	}

	for _, n := range notesToCreate {
		note, err := s.notes.Create(ctx, n.title, &n.content, nil, n.tags)
		if err != nil {
			return fmt.Errorf("create note %q: %w", n.title, err)
		}
		_, _ = fmt.Fprintf(w, "  ✓ %s → /notes/%s\n", note.Title, note.Slug)
	}

	_, _ = fmt.Fprintf(w, "\nDone. Seeded %d notes, %d tags, and 3 artifacts.\n", len(notesToCreate), len(demoTags))
	return nil
}

// tag creates a tag with the given slug.
func (s *seeder) tag(ctx context.Context, slug string) error {
	_, err := s.tags.Create(ctx, slug)
	return err
}

// artifact stores content of the given type and returns its SHA-256 digest, the
// key used to reference it from a note's Markdown.
func (s *seeder) artifact(ctx context.Context, content []byte, contentType string) (string, error) {
	a, err := s.artifacts.Create(ctx, content, contentType)
	if err != nil {
		return "", err
	}
	return a.SHA256, nil
}

// demoTags are the tag slugs every demo note is drawn from.
var demoTags = []string{
	"getting-started",
	"reference",
	"personal",
	"work",
	"recipes",
	"travel",
}

// barChartPNG renders a simple three-bar chart as a PNG. Generating the bytes
// programmatically guarantees valid PNG magic bytes so the artifact service's
// content check passes.
func barChartPNG() ([]byte, error) {
	const w, h = 480, 300
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	bg := color.RGBA{R: 0xf8, G: 0xfa, B: 0xfc, A: 0xff}
	draw(img, bg)

	// Draw three bars of increasing height in indigo/green/amber.
	palette := []color.RGBA{
		{R: 0x63, G: 0x66, B: 0xf1, A: 0xff},
		{R: 0x22, G: 0xc5, B: 0x5e, A: 0xff},
		{R: 0xf5, G: 0x9e, B: 0x0b, A: 0xff},
	}
	heights := []int{120, 200, 160}
	const barW, gap, baseY = 100, 40, 260
	for i, hgt := range heights {
		x0 := 40 + i*(barW+gap)
		for y := baseY - hgt; y < baseY; y++ {
			for x := x0; x < x0+barW; x++ {
				img.Set(x, y, palette[i])
			}
		}
	}
	// Baseline axis.
	axis := color.RGBA{R: 0x94, G: 0xa3, B: 0xb8, A: 0xff}
	for x := 20; x < w-20; x++ {
		img.Set(x, baseY, axis)
		img.Set(x, baseY+1, axis)
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// gradientPNG renders a warm diagonal gradient as a stand-in "photo" for the
// recipe note.
func gradientPNG() ([]byte, error) {
	const w, h = 480, 320
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			t := float64(x+y) / float64(w+h)
			r := uint8(0xf5 - int(0x40*t))
			g := uint8(0x9e + int(0x30*t))
			b := uint8(0x0b + int(0x60*t))
			img.Set(x, y, color.RGBA{R: r, G: g, B: b, A: 0xff})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// draw fills the whole image with a single color.
func draw(img *image.RGBA, c color.RGBA) {
	b := img.Bounds()
	for y := range b.Max.Y {
		for x := range b.Max.X {
			img.Set(x, y, c)
		}
	}
}
