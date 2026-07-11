package asciimath

import "testing"

// Reference outputs are taken verbatim from the vendored asciimath2ml (v1.0.8)
// JS library (web/ts/vendor), the source of truth this port mirrors. Keeping
// them here guards against divergence between the web client and the server.
func TestToMathML(t *testing.T) {
	cases := []struct {
		in     string
		inline bool
		want   string
	}{
		{"x^2", true, `<math display="inline"><mstyle displaystyle="true"><msup><mi>x</mi><mn>2</mn></msup></mstyle></math>`},
		{"x^2", false, `<math display="block"><mstyle displaystyle="true"><msup><mi>x</mi><mn>2</mn></msup></mstyle></math>`},
		{"sqrt(x+1)", true, `<math display="inline"><mstyle displaystyle="true"><msqrt><mrow><mo>&#40;</mo><mi>x</mi><mo>&#43;</mo><mn>1</mn><mo>&#41;</mo></mrow></msqrt></mstyle></math>`},
		{"frac{a}{b}", true, `<math display="inline"><mstyle displaystyle="true"><mfrac><mrow><mi>a</mi></mrow><mrow><mi>b</mi></mrow></mfrac></mstyle></math>`},
		{"a/b", true, `<math display="inline"><mstyle displaystyle="true"><mfrac><mi>a</mi><mi>b</mi></mfrac></mstyle></math>`},
		{"sum_(i=1)^n i", false, `<math display="block"><mstyle displaystyle="true"><munderover><mo>&#x2211;</mo><mrow><mo>&#40;</mo><mi>i</mi><mo>&#61;</mo><mn>1</mn><mo>&#41;</mo></mrow><mi>n</mi></munderover><mi>i</mi></mstyle></math>`},
		{"alpha + beta", true, `<math display="inline"><mstyle displaystyle="true"><mi>&#x03B1;</mi><mo>&#43;</mo><mi>&#x03B2;</mi></mstyle></math>`},
		{"sin x", true, `<math display="inline"><mstyle displaystyle="true"><mrow><mo>sin</mo><mi>x</mi></mrow></mstyle></math>`},
		{"(a,b)", true, `<math display="inline"><mstyle displaystyle="true"><mrow><mo>&#40;</mo><mi>a</mi><mo>&#44;</mo><mi>b</mi><mo>&#41;</mo></mrow></mstyle></math>`},
		{"bb(A)", true, `<math display="inline"><mstyle displaystyle="true"><mstyle style="font-weight: bold"><mrow><mo>&#40;</mo><mi>A</mi><mo>&#41;</mo></mrow></mstyle></mstyle></math>`},
		{"cc(R)", true, `<math display="inline"><mstyle displaystyle="true"><mrow><mo>&#40;</mo><mi>ℛ</mi><mo>&#41;</mo></mrow></mstyle></math>`},
		{"abs(x)", true, `<math display="inline"><mstyle displaystyle="true"><mrow><mo>&#124;</mo><mrow><mo>&#40;</mo><mi>x</mi><mo>&#41;</mo></mrow><mo>&#124;</mo></mrow></mstyle></math>`},
		{"lim_(x->0) f(x)", false, `<math display="block"><mstyle displaystyle="true"><munder><mo>lim</mo><mrow><mo>&#40;</mo><mi>x</mi><mo>&#x2192;</mo><mn>0</mn><mo>&#41;</mo></mrow></munder><mi>f</mi><mrow><mo>&#40;</mo><mi>x</mi><mo>&#41;</mo></mrow></mstyle></math>`},
		{"1.5 + 2", true, `<math display="inline"><mstyle displaystyle="true"><mn>1.5</mn><mo>&#43;</mo><mn>2</mn></mstyle></math>`},
		{`"hello"`, true, `<math display="inline"><mstyle displaystyle="true"><mtext>hello</mtext></mstyle></math>`},
		{"x_i^2", true, `<math display="inline"><mstyle displaystyle="true"><msubsup><mi>x</mi><mi>i</mi><mn>2</mn></msubsup></mstyle></math>`},
		{"root(3)(x)", true, `<math display="inline"><mstyle displaystyle="true"><mroot><mrow><mo>&#40;</mo><mn>3</mn><mo>&#41;</mo></mrow><mrow><mo>&#40;</mo><mi>x</mi><mo>&#41;</mo></mrow></mroot></mstyle></math>`},
		{"[[a,b],[c,d]]", true, `<math display="inline"><mstyle displaystyle="true"><mrow><mo>&#91;</mo><mrow><mo>&#91;</mo><mi>a</mi><mo>&#44;</mo><mi>b</mi><mo>&#93;</mo></mrow><mo>&#44;</mo><mrow><mo>&#91;</mo><mi>c</mi><mo>&#44;</mo><mi>d</mi><mo>&#93;</mo></mrow><mo>&#93;</mo></mrow></mstyle></math>`},
		{"(| a ; b |)", true, `<math display="inline"><mstyle displaystyle="true"><mrow><mo>&#40;</mo><mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr></mtable><mo>&#41;</mo></mrow></mstyle></math>`},
		{"a mod b", true, `<math display="inline"><mstyle displaystyle="true"><mi>a</mi><mrow><mspace width="1ex"/><mtext>mod</mtext><mspace width="1ex"/></mrow><mi>b</mi></mstyle></math>`},
		{"!@#invalidsym", true, `<math display="inline"><mstyle displaystyle="true"><mo>&#33;</mo><mo>&#x2218;</mo><merror><mtext>#</mtext></merror><mo>&#x2208;</mo><mi>v</mi><mi>a</mi><mi>l</mi><mrow id="s"><mi>y</mi></mrow><mi>m</mi></mstyle></math>`},
		{"", true, `<math display="inline"><mstyle displaystyle="true"></mstyle></math>`},
	}
	for _, c := range cases {
		if got := ToMathML(c.in, c.inline); got != c.want {
			t.Errorf("ToMathML(%q, %v)\n got: %s\nwant: %s", c.in, c.inline, got, c.want)
		}
	}
}

// Unterminated matrices must not panic (the "never throws" contract): a matrix
// opened with (| that never closes runs the scanner position negative in the
// row/matrix parsers, which skipWhitespace must tolerate.
func TestUnterminatedInputDoesNotPanic(t *testing.T) {
	for _, in := range []string{"(| a ; b", "(|a", "{: x", "[[a,b", "sqrt", "frac{a}"} {
		_ = ToMathML(in, true) // must simply return, not panic
	}
}
