package termsafe

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEscaping(t *testing.T) {
	input := "café 日本語 �\t\n\x1b]52;c;payload\a\r\b\x7f\u009b\x9b\xff"
	expected := "café 日本語 �\t\n" + `\x1b]52;c;payload\a\r\b\x7f\u009b\x9b\xff`
	assert.Equal(t, expected, String(input))
	var out bytes.Buffer
	require.NoError(t, Copy(&out, iotest.OneByteReader(strings.NewReader(input))))
	assert.Equal(t, expected, out.String())
	assert.Equal(t, expected, String(expected))
}

func TestCopyErrors(t *testing.T) {
	failure := errors.New("failed")
	assert.ErrorIs(t, Copy(io.Discard, iotest.ErrReader(failure)), failure)
	assert.ErrorIs(t, Copy(failedWriter{failure}, strings.NewReader("hello")), failure)
}

type failedWriter struct{ err error }

func (w failedWriter) Write([]byte) (int, error) { return 0, w.err }
