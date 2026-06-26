package service

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// frontmatterData holds the structured fields extracted from a Markdown
// frontmatter block. Zero values mean "field was absent".
type frontmatterData struct {
	Title string
	Date  time.Time // zero if absent or unparseable
	Slug  string    // empty if absent
}

// parseFrontmatter detects and strips YAML (--- delimiters), TOML (+++
// delimiters), or JSON ({ ... }) frontmatter from Markdown content. Returns
// the structured fields and the remaining content with the frontmatter block
// removed. Returns zero-value fields and the original content when no
// frontmatter is recognised.
func parseFrontmatter(content string) (frontmatterData, string) {
	if strings.HasPrefix(content, "---") {
		if fmText, b, ok := parseDelimitedFrontmatter(content[3:], "---"); ok {
			return parseYAMLFrontmatter(fmText), b
		}
	} else if strings.HasPrefix(content, "+++") {
		if fmText, b, ok := parseDelimitedFrontmatter(content[3:], "+++"); ok {
			return parseTOMLFrontmatter(fmText), b
		}
	} else if strings.HasPrefix(content, "{") {
		if data, b, ok := parseJSONFrontmatter(content); ok {
			return data, b
		}
	}
	return frontmatterData{}, content
}

// parseDelimitedFrontmatter parses the text between an already-consumed
// opening delimiter and the matching closing delimiter. rest is the content
// immediately after the opening delimiter. Returns the raw frontmatter text,
// the content following the closing delimiter, and whether the parse
// succeeded. The opening and closing delimiter must each occupy their own
// line; the opening is followed by \n or \r\n, and the closing is followed by
// \n, \r\n, or end-of-input.
func parseDelimitedFrontmatter(rest, delim string) (fmText, body string, ok bool) {
	if strings.HasPrefix(rest, "\r\n") {
		rest = rest[2:]
	} else if strings.HasPrefix(rest, "\n") {
		rest = rest[1:]
	} else {
		return "", "", false
	}

	// Closing delimiter may appear immediately (empty frontmatter) or after content.
	var idx int
	if strings.HasPrefix(rest, delim) {
		idx = 0
	} else {
		idx = strings.Index(rest, "\n"+delim)
		if idx == -1 {
			return "", "", false
		}
		idx++ // advance past the \n so rest[idx:] starts at the delimiter
	}

	fmText = rest[:idx]
	rest = rest[idx+len(delim):]

	if rest == "" {
		return fmText, "", true
	}
	if strings.HasPrefix(rest, "\r\n") {
		return fmText, rest[2:], true
	}
	if strings.HasPrefix(rest, "\n") {
		return fmText, rest[1:], true
	}
	// Closing delimiter has trailing non-newline content — not valid frontmatter.
	return "", "", false
}

func parseYAMLFrontmatter(fmText string) frontmatterData {
	var raw struct {
		Title string      `yaml:"title"`
		Date  interface{} `yaml:"date"`
		Slug  string      `yaml:"slug"`
	}
	if err := yaml.Unmarshal([]byte(fmText), &raw); err != nil {
		return frontmatterData{}
	}
	result := frontmatterData{Title: raw.Title, Slug: raw.Slug}
	switch v := raw.Date.(type) {
	case time.Time:
		result.Date = v
	case string:
		if t, ok := parseDate(v); ok {
			result.Date = t
		}
	}
	return result
}

// TOML double-quoted basic string: title = "value" (with backslash escapes)
// TOML single-quoted literal string: title = 'value'
// TOML bare date value: date = 2024-01-15 or date = 2024-01-15T10:30:00Z
var (
	tomlTitleDoubleRe = regexp.MustCompile(`(?m)^title\s*=\s*"((?:[^"\\]|\\.)*)"`)
	tomlTitleSingleRe = regexp.MustCompile(`(?m)^title\s*=\s*'([^']*)'`)
	tomlSlugDoubleRe  = regexp.MustCompile(`(?m)^slug\s*=\s*"((?:[^"\\]|\\.)*)"`)
	tomlSlugSingleRe  = regexp.MustCompile(`(?m)^slug\s*=\s*'([^']*)'`)
	// date value: quoted string or bare TOML date (starts YYYY-MM-DD, no trailing text on line)
	tomlDateRe = regexp.MustCompile(`(?m)^date\s*=\s*(?:"([^"]*)"|'([^']*)'|([0-9]{4}-[0-9]{2}-[0-9]{2}[^\s#]*))`)
)

func parseTOMLFrontmatter(fmText string) frontmatterData {
	return frontmatterData{
		Title: tomlStringField(fmText, tomlTitleDoubleRe, tomlTitleSingleRe),
		Slug:  tomlStringField(fmText, tomlSlugDoubleRe, tomlSlugSingleRe),
		Date:  tomlDate(fmText),
	}
}

func tomlStringField(fmText string, doubleRe, singleRe *regexp.Regexp) string {
	if m := doubleRe.FindStringSubmatch(fmText); m != nil {
		return m[1]
	}
	if m := singleRe.FindStringSubmatch(fmText); m != nil {
		return m[1]
	}
	return ""
}

func tomlDate(fmText string) time.Time {
	m := tomlDateRe.FindStringSubmatch(fmText)
	if m == nil {
		return time.Time{}
	}
	// Groups: 1=double-quoted, 2=single-quoted, 3=bare value
	var raw string
	switch {
	case m[1] != "":
		raw = m[1]
	case m[2] != "":
		raw = m[2]
	default:
		raw = strings.TrimSpace(m[3])
	}
	t, _ := parseDate(raw)
	return t
}

func parseJSONFrontmatter(content string) (frontmatterData, string, bool) {
	dec := json.NewDecoder(strings.NewReader(content))
	var raw struct {
		Title string `json:"title"`
		Date  string `json:"date"`
		Slug  string `json:"slug"`
	}
	if err := dec.Decode(&raw); err != nil {
		return frontmatterData{}, "", false
	}
	data := frontmatterData{Title: raw.Title, Slug: raw.Slug}
	if t, ok := parseDate(raw.Date); ok {
		data.Date = t
	}
	// InputOffset is the byte position immediately after the decoded JSON value.
	rest := strings.TrimLeft(content[dec.InputOffset():], " \t\r\n")
	return data, rest, true
}

// dateFormats lists the formats tried in order when parsing a date string.
// RFC3339 covers the common ISO-8601 datetime; the bare date covers Hugo/Jekyll
// frontmatter that stores only the calendar date.
var dateFormats = []string{
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05Z07:00",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

func parseDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, f := range dateFormats {
		if t, err := time.Parse(f, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
