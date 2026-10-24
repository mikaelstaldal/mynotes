// Package termsafe escapes terminal control sequences in human-readable output.
package termsafe

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode"
)

// String escapes controls other than TAB/LF and invalid UTF-8 bytes.
// Ordinary Unicode text is preserved. Apply this only at display boundaries.
func String(s string) string {
	var out strings.Builder
	_ = Copy(&out, strings.NewReader(s))
	return out.String()
}

// Copy streams escaped text to dst, including when UTF-8 spans input reads.
func Copy(dst io.Writer, src io.Reader) (err error) {
	buffered := bufio.NewWriter(dst)
	defer func() { err = errors.Join(err, buffered.Flush()) }()
	reader := bufio.NewReader(src)
	for {
		r, size, err := reader.ReadRune()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		var text string
		if r == unicode.ReplacementChar && size == 1 {
			// Invalid UTF-8 may include a terminal's single-byte C1 controls.
			if err := reader.UnreadRune(); err != nil {
				return err
			}
			b, err := reader.ReadByte()
			if err != nil {
				return err
			}
			text = fmt.Sprintf("\\x%02x", b)
		} else if unicode.IsControl(r) && r != '\t' && r != '\n' {
			quoted := strconv.QuoteRune(r)
			text = quoted[1 : len(quoted)-1]
		} else {
			text = string(r)
		}
		if _, err := io.WriteString(buffered, text); err != nil {
			return err
		}
	}
}
