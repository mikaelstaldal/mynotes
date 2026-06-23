package service

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateMarkdownStructure_Accepts(t *testing.T) {
	cases := map[string]string{
		"empty":                 "",
		"plain prose":           "Hello *world*, this is **markdown**.\n\nA second paragraph.",
		"tab/newline/cr":        "line1\n\tindented\r\nline2",
		"gfm table":             "| a | b |\n| - | - |\n| 1 | 2 |",
		"strikethrough":         "~~gone~~",
		"http link":             "[x](http://example.com)",
		"https link":            "[x](https://example.com/path?q=1#f)",
		"mailto link":           "[mail](mailto:a@b.com)",
		"root-relative link":    "[note](/notes/my-note)",
		"bare-relative link":    "[rel](foo/bar)",
		"dot-relative link":     "[rel](./bar)",
		"fragment link":         "[rel](#section)",
		"https image":           "![alt](https://example.com/a.png)",
		"relative image":        "![alt](/img/a.png)",
		"data raster image":     "![alt](data:image/png;base64,iVBORw0KGgo=)",
		"autolink url":          "<https://example.com>",
		"autolink email":        "<a@b.com>",
		"safe inline html":      "text <b>bold</b> and <a href=\"https://x.com\">link</a>",
		"safe block html":       "<div>\n<p>hello</p>\n</div>",
		"br void tag":           "line<br>break",
		"sub sup mark":          "H<sub>2</sub>O E=mc<sup>2</sup> <mark>hi</mark>",
		"embedded https img":    "<img src=\"https://x.com/a.png\" alt=\"x\">",
		"embedded relative img": "<img src=\"/a.png\">",
		"embedded data img":     "<img src=\"data:image/gif;base64,R0lGOD==\">",
		"angle in text":         "5 < 6 and 7 > 2",
		"deep but ok nesting":   strings.Repeat("> ", 50) + "deep",
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			if err := validateMarkdownStructure(content); err != nil {
				t.Fatalf("expected accept, got reject: %v", err)
			}
		})
	}
}

func TestValidateMarkdownStructure_Rejects(t *testing.T) {
	cases := map[string]string{
		"script tag":                  "<script>alert(1)</script>",
		"inline script":               "ok <script>alert(1)</script>",
		"onerror handler":             "<img src=\"https://x/a.png\" onerror=\"alert(1)\">",
		"javascript href html":        "<a href=\"javascript:alert(1)\">x</a>",
		"iframe":                      "<iframe src=\"https://x\"></iframe>",
		"style tag":                   "<style>body{}</style>",
		"data svg embedded img":       "<img src=\"data:image/svg+xml;base64,PHN2Zz4=\">",
		"http embedded img":           "<img src=\"http://example.com/a.png\">",
		"mailto embedded img":         "<img src=\"mailto:a@b\">",
		"scheme-rel embedded img":     "<img src=\"//evil.com/a.png\">",
		"data embedded link":          "<a href=\"data:image/png;base64,iVBOR\">x</a>",
		"javascript embedded img src": "<img src=\"javascript:alert(1)\">",
		"scheme-rel embedded link":    "<a href=\"//evil.com/x\">x</a>",

		"javascript link":         "[x](javascript:alert(1))",
		"vbscript link":           "[x](vbscript:msgbox(1))",
		"file link":               "[x](file:///etc/passwd)",
		"data text/html link":     "[x](data:text/html,<script>alert(1)</script>)",
		"data image on link":      "[x](data:image/png;base64,iVBOR)",
		"scheme-relative link":    "[x](//evil.com/path)",
		"scheme-relative image":   "![x](//evil.com/a.png)",
		"http image":              "![x](http://example.com/a.png)",
		"data svg image":          "![x](data:image/svg+xml;base64,PHN2Zz4=)",
		"data no-semicolon image": "![x](data:image/png,foo)",

		"nul byte":   "before\x00after",
		"sentinel 2": "a\x02b",
		"sentinel 3": "a\x03b",
		"form feed":  "a\x0cb",
		"vtab":       "a\x0bb",
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			err := validateMarkdownStructure(content)
			if err == nil {
				t.Fatalf("expected reject, got accept")
			}
			if !errors.Is(err, ErrValidation) {
				t.Fatalf("expected ErrValidation, got %v", err)
			}
		})
	}
}

func TestValidateMarkdownStructure_DeepNesting(t *testing.T) {
	// Blockquote markers nest one level each; well past 100 must be rejected.
	deep := strings.Repeat(">", 200) + " x"
	if err := validateMarkdownStructure(deep); !errors.Is(err, ErrValidation) {
		t.Fatalf("expected deep nesting reject, got %v", err)
	}
}

func TestValidateMarkdownStructure_CaseInsensitiveScheme(t *testing.T) {
	if err := validateMarkdownStructure("[x](HTTP://example.com)"); err != nil {
		t.Fatalf("uppercase HTTP link should be accepted: %v", err)
	}
	if err := validateMarkdownStructure("![x](DATA:IMAGE/PNG;base64,AAAA)"); err != nil {
		t.Fatalf("uppercase data raster image should be accepted: %v", err)
	}
	if err := validateMarkdownStructure("[x](JavaScript:alert(1))"); !errors.Is(err, ErrValidation) {
		t.Fatalf("mixed-case javascript link should be rejected: %v", err)
	}
}
