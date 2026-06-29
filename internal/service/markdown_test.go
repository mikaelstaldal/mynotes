package service

import (
	"errors"
	"strings"
	"testing"

	"github.com/mikaelstaldal/mynotes/internal/sanitize"
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
		"kbd":                   "press <kbd>Ctrl</kbd> then <kbd>C</kbd>",
		"abbr del ins":          "<abbr title=\"HyperText\">HTML</abbr> <del>old</del> <ins>new</ins>",
		"figure figcaption":     "<figure><img src=\"/a.png\" alt=\"x\"><figcaption>cap</figcaption></figure>",
		"details summary":       "<details><summary>more</summary>\n\nhidden body\n\n</details>",
		"aligned table html":    "<table><thead><tr><th align=\"right\">n</th></tr></thead><tbody><tr><td align=\"right\">1</td></tr></tbody></table>",
		"embedded https img":    "<img src=\"https://x.com/a.png\" alt=\"x\">",
		"embedded relative img": "<img src=\"/a.png\">",
		"embedded data img":     "<img src=\"data:image/gif;base64,R0lGOD==\">",
		"angle in text":         "5 < 6 and 7 > 2",
		"deep but ok nesting":   strings.Repeat("> ", 50) + "deep",
		// SVG
		"svg basic shapes": "<svg width=\"100\" height=\"100\"><circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"blue\"/></svg>",
		"svg path rect":    "<svg><rect width=\"50\" height=\"50\"/><path d=\"M0 0 L10 10\"/></svg>",
		"svg text":         "<svg><text x=\"10\" y=\"20\">label</text></svg>",
		"svg gradient":     "<svg><defs><linearGradient id=\"g\"><stop offset=\"0%\" stop-color=\"red\"/></linearGradient></defs><rect fill=\"url(#g)\" width=\"50\" height=\"50\"/></svg>",
		"svg filter":       "<svg><defs><filter id=\"f\"><feGaussianBlur stdDeviation=\"3\"/></filter></defs><rect filter=\"url(#f)\" width=\"50\" height=\"50\"/></svg>",
		"svg image https":  "<svg><image href=\"https://example.com/logo.png\" width=\"50\" height=\"50\"/></svg>",
		"svg textpath":     "<svg><defs><path id=\"p\" d=\"M0 0 L100 0\"/></defs><text><textPath href=\"#p\">text</textPath></text></svg>",
		// MathML
		"mathml fraction":    "<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>",
		"mathml sqrt":        "<math display=\"block\"><msqrt><mn>2</mn></msqrt></math>",
		"mathml superscript": "<math><msup><mi>x</mi><mn>2</mn></msup></math>",
		"mathml table":       "<math><mtable><mtr><mtd><mn>1</mn></mtd></mtr></mtable></math>",
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
		"input":                       "<input type=\"text\" value=\"x\">",
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

		// SVG unsafe
		"svg with script":      "<svg><script>alert(1)</script></svg>",
		"svg onerror handler":  "<svg><circle onmouseover=\"alert(1)\" cx=\"10\" cy=\"10\" r=\"5\"/></svg>",
		"svg foreignobject":    "<svg><foreignObject><div>html</div></foreignObject></svg>",
		"svg use external":     "<svg><use href=\"https://evil.com/file.svg#icon\"/></svg>",
		"svg style block":      "<svg><style>circle{fill:red}</style><circle r=\"5\"/></svg>",
		"svg image javascript": "<svg><image href=\"javascript:alert(1)\" width=\"50\" height=\"50\"/></svg>",
		// MathML unsafe
		"mathml with script": "<math><mi><script>alert(1)</script></mi></math>",
		"mathml annotation":  "<math><semantics><mn>1</mn><annotation encoding=\"application/x-tex\">1</annotation></semantics></math>",

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

// TestRemovalOnlyRoundTripSpike is the milestone-3 guard (§4.1): benign HTML that
// bluemonday *reformats* (quotes unquoted attrs, closes void tags) — and a
// representative slice of the broad safe allow-list — must pass the gate
// unrejected. The accept/reject decision compares bluemonday's output against a
// canonical re-serialization of the original, so pure reformatting cancels and
// only genuinely stripped/rewritten (unsafe) content trips a rejection. A missed
// injector (or one a future bluemonday version adds) would make even safe HTML
// diverge from its re-serialization and be falsely rejected; this test catches
// that here rather than in production.
func TestRemovalOnlyRoundTripSpike(t *testing.T) {
	// reformatted: bluemonday's serialization differs byte-for-byte from the raw
	// fragment (it adds quotes / closes the void tag), yet the gate must still
	// accept it. The require below asserts the reformat actually happens, so the
	// case stays meaningful — if it ever stopped diverging it would no longer
	// exercise the canonicalization path.
	reformatted := map[string]string{
		"unquoted href attr": "<a href=https://x.com>x</a>",
		"unquoted img attrs": "<img src=https://x.com/a.png alt=x>",
	}
	for name, raw := range reformatted {
		t.Run("reformatted/"+name, func(t *testing.T) {
			if sanitize.HTML(raw) == raw {
				t.Fatalf("expected bluemonday to reformat %q, but it was unchanged — case no longer exercises the spike", raw)
			}
			if err := validateMarkdownStructure(raw); err != nil {
				t.Fatalf("benign reformatted HTML falsely rejected: %v", err)
			}
		})
	}

	// allowListed: a representative slice of the broad safe allow-list (§4.1, §10),
	// each of which must pass unrejected. (These mostly re-serialize identically;
	// they guard the allow-list breadth rather than the reformat path.)
	allowListed := []string{
		"plain link <a href=\"https://x.com\">x</a>",
		"<br>",
		"<sub>2</sub> <sup>2</sup> <mark>hi</mark>",
		"<kbd>Ctrl</kbd>",
		"<abbr title=\"x\">y</abbr> <del>a</del> <ins>b</ins>",
		"<details><summary>s</summary>\n\nbody\n\n</details>",
		"<div><span>x</span></div>",
		"<figure><figcaption>c</figcaption></figure>",
		"<table><tbody><tr><td align=\"right\">1</td></tr></tbody></table>",
		"<a href=\"https://x.com\">l</a> and <img src=\"https://x.com/a.png\" alt=\"x\">",
	}
	for _, raw := range allowListed {
		t.Run("allowlisted/"+raw, func(t *testing.T) {
			if err := validateMarkdownStructure(raw); err != nil {
				t.Fatalf("allow-listed HTML falsely rejected: %v", err)
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
