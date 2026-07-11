// Package asciimath converts AsciiMath (https://asciimath.org) expressions to
// MathML strings.
//
// This is a faithful Go port of the vendored asciimath2ml (v1.0.8) library the
// web frontend uses (see web/ts/vendor and its use in web/ts/util/markdown.ts),
// and of the equivalent Kotlin port in the Android app, so $…$ / $$…$$ math
// renders equivalently across the web client, the Android app and server-side
// HTML export. The parser is a self-contained recursive-descent scanner working
// purely with strings — no external dependencies. Malformed input never throws:
// an unrecognized symbol becomes a <merror> node, so a note always renders.
//
// The produced <math> markup flows through the same bluemonday sanitizer as all
// other rendered HTML in the server export (whose allow-list already covers the
// MathML element/attribute set), so math markup is sanitized like everything
// else — nothing bypasses the render-time gate.
package asciimath

import (
	"strconv"
	"strings"
	"unicode"
)

// ToMathML converts input AsciiMath to a MathML string. inline selects inline
// vs. display style; when false the output is a display (block) equation.
//
// The upstream escapePunctuation flag (which entity-escapes non-alphanumerics in
// "…" text fragments) is left off, matching the web client, which relies on
// sanitization instead.
func ToMathML(input string, inline bool) string {
	sc := newScanner(input, false)
	display := "block"
	if inline {
		display = "inline"
	}
	return `<math display="` + display + `"><mstyle displaystyle="true">` + exprParser(sc) + "</mstyle></math>"
}

// ## Symbols
//
// Symbols are values returned by the scanner. Each symbol has a symbolKind.
// kindDefault symbols do not affect syntax rules — they usually transform
// directly to a MathML fragment. The other kinds trigger special processing in
// the parser.
type symbolKind int

const (
	kindDefault symbolKind = iota
	kindUnderOver
	kindLeftBracket
	kindRightBracket
	kindMatrixLeftBracket
	kindMatrixRightBracket
	kindMatrixCellSep
	kindMatrixRowSep
	kindEof
)

type parserFunc func(*scanner) string

type symbol struct {
	kind   symbolKind
	input  string
	parser parserFunc
}

// The scanner tokenizes the AsciiMath input. To output a variable in a special
// font (blackboard, calligraphic, fraktur) it maps character codes to another
// unicode range; when a font command is in effect the corresponding table is
// pushed onto charTables.
type scanner struct {
	input             []rune
	escapePunctuation bool
	pos               int
	charTables        [][]string
}

func newScanner(input string, escapePunctuation bool) *scanner {
	return &scanner{input: []rune(input), escapePunctuation: escapePunctuation}
}

// skipWhitespace skips whitespace and returns the index of the next token, or -1
// past the end of input. A negative pos (only reachable from the matrix parsers
// on malformed input) is treated as end of input rather than panicking, keeping
// the "never throws" contract.
func (s *scanner) skipWhitespace() int {
	if s.pos < 0 {
		return -1
	}
	for s.pos < len(s.input) && unicode.IsSpace(s.input[s.pos]) {
		s.pos++
	}
	if s.pos < len(s.input) {
		return s.pos
	}
	return -1
}

// peekSymbol peeks the next symbol without consuming it, returning the symbol
// and the position to advance to in order to skip it. Whitespace preceding the
// symbol is skipped (mutating pos). A negative position and an eof symbol are
// returned at the end of input. The symbol table lists symbols per starting
// character in descending length order, so the first match is the longest one.
func (s *scanner) peekSymbol() (*symbol, int) {
	start := s.skipWhitespace()
	if start < 0 {
		return eofSymbol(), start
	}
	curr := s.input[start]
	// Text "..." string in doublequotes. With escapePunctuation, non-alphanumerics
	// are escaped.
	if curr == '"' {
		p := start + 1
		for p < len(s.input) && s.input[p] != '"' {
			p++
		}
		txt := string(s.input[start+1 : p])
		if s.escapePunctuation {
			txt = escapePunct(txt)
		}
		return textSymbol(txt), p + 1
	}
	// Number; the only accepted decimal separator is dot '.'.
	if curr >= '0' && curr <= '9' {
		p := start
		for p < len(s.input) && ((s.input[p] >= '0' && s.input[p] <= '9') || s.input[p] == '.') {
			p++
		}
		return numberSymbol(string(s.input[start:p])), p
	}
	// Longest matching symbol from the table.
	if syms, ok := symbols[curr]; ok {
		for _, sym := range syms {
			n := len(sym.input) // symbol inputs are ASCII, so byte length == rune length
			if start+n <= len(s.input) && runeRegionMatches(s.input, start, sym.input) {
				return sym, start + n
			}
		}
	}
	// No matching symbol: skip the current character and return an error.
	return errorSymbol(string(curr)), start + 1
}

// nextSymbol gets the next symbol and advances the position.
func (s *scanner) nextSymbol() *symbol {
	sym, p := s.peekSymbol()
	if p >= 0 {
		s.pos = p
	}
	return sym
}

func (s *scanner) pushCharTable(table []string) { s.charTables = append(s.charTables, table) }

func (s *scanner) popCharTable() {
	if len(s.charTables) > 0 {
		s.charTables = s.charTables[:len(s.charTables)-1]
	}
}

func (s *scanner) charTable() []string {
	if len(s.charTables) == 0 {
		return nil
	}
	return s.charTables[len(s.charTables)-1]
}

// runeRegionMatches reports whether input[start:] begins with the ASCII string sub.
func runeRegionMatches(input []rune, start int, sub string) bool {
	for i := 0; i < len(sub); i++ {
		if input[start+i] != rune(sub[i]) {
			return false
		}
	}
	return true
}

// ## Character Tables
//
// Font commands remap upper- and lower-case latin letters to alternate unicode
// ranges. Other characters are left unchanged. The tables below cover
// calligraphic, fraktur and blackboard fonts.
var calTable = []string{
	"𝒜", "ℬ", "𝒞", "𝒟", "ℰ",
	"ℱ", "𝒢", "ℋ", "ℐ", "𝒥", "𝒦",
	"ℒ", "ℳ", "𝒩", "𝒪", "𝒫",
	"𝒬", "ℛ", "𝒮", "𝒯", "𝒰",
	"𝒱", "𝒲", "𝒳", "𝒴",
	"𝒵", "𝒶", "𝒷", "𝒸",
	"𝒹", "ℯ", "𝒻", "ℊ", "𝒽",
	"𝒾", "𝒿", "𝓀", "𝓁",
	"𝓂", "𝓃", "ℴ", "𝓅", "𝓆",
	"𝓇", "𝓈", "𝓉", "𝓊",
	"𝓋", "𝓌", "𝓍", "𝓎",
	"𝓏",
}

var frkTable = []string{
	"𝔄", "𝔅", "ℭ", "𝔇",
	"𝔈", "𝔉", "𝔊", "ℌ", "ℑ",
	"𝔍", "𝔎", "𝔏", "𝔐",
	"𝔑", "𝔒", "𝔓", "𝔔", "ℜ",
	"𝔖", "𝔗", "𝔘", "𝔙",
	"𝔚", "𝔛", "𝔜", "ℨ", "𝔞",
	"𝔟", "𝔠", "𝔡", "𝔢",
	"𝔣", "𝔤", "𝔥", "𝔦",
	"𝔧", "𝔨", "𝔩", "𝔪",
	"𝔫", "𝔬", "𝔭", "𝔮",
	"𝔯", "𝔰", "𝔱", "𝔲",
	"𝔳", "𝔴", "𝔵", "𝔶",
	"𝔷",
}

var bbbTable = []string{
	"𝔸", "𝔹", "ℂ", "𝔻",
	"𝔼", "𝔽", "𝔾", "ℍ", "𝕀",
	"𝕁", "𝕂", "𝕃", "𝕄", "ℕ",
	"𝕆", "ℙ", "ℚ", "ℝ", "𝕊", "𝕋",
	"𝕌", "𝕍", "𝕎", "𝕏",
	"𝕐", "ℤ", "𝕒", "𝕓", "𝕔",
	"𝕕", "𝕖", "𝕗", "𝕘",
	"𝕙", "𝕚", "𝕛", "𝕜",
	"𝕝", "𝕞", "𝕟", "𝕠",
	"𝕡", "𝕢", "𝕣", "𝕤",
	"𝕥", "𝕦", "𝕧", "𝕨",
	"𝕩", "𝕪", "𝕫",
}

// convertText converts text using table; if no table is active the text is
// returned unchanged.
func convertText(text string, table []string) string {
	if table == nil {
		return text
	}
	var res strings.Builder
	for _, ch := range text {
		c := int(ch)
		switch {
		case c >= 65 && c <= 90:
			res.WriteString(table[c-65])
		case c >= 97 && c <= 122:
			res.WriteString(table[c-71])
		default:
			res.WriteRune(ch)
		}
	}
	return res.String()
}

func escapePunct(s string) string {
	var b strings.Builder
	for _, ch := range s {
		if (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') {
			b.WriteRune(ch)
		} else {
			b.WriteString("&#" + strconv.Itoa(int(ch)) + ";")
		}
	}
	return b.String()
}

// ### Terminal symbol constructors

// text renders regular text inside equations, upright in <mtext> (with font
// translation applied).
func textSymbol(input string) *symbol {
	return &symbol{kindDefault, input, func(s *scanner) string {
		return "<mtext>" + convertText(input, s.charTable()) + "</mtext>"
	}}
}

// numberSymbol renders numbers as <mn> elements.
func numberSymbol(input string) *symbol {
	return &symbol{kindDefault, input, func(*scanner) string { return "<mn>" + input + "</mn>" }}
}

// errorSymbol renders invalid/unrecognized input as a <merror> node.
func errorSymbol(msg string) *symbol {
	return &symbol{kindDefault, "", func(*scanner) string {
		return "<merror><mtext>" + msg + "</mtext></merror>"
	}}
}

// eofSymbol is the end-of-input marker; it terminates expression parsing and
// produces no output.
func eofSymbol() *symbol {
	return &symbol{kindEof, "", func(*scanner) string { return "" }}
}

// ident renders variables/identifiers as <mi> elements (with font translation
// applied).
func ident(input string, output ...string) *symbol {
	out := input
	if len(output) > 0 {
		out = output[0]
	}
	return &symbol{kindDefault, input, func(s *scanner) string {
		return "<mi>" + convertText(out, s.charTable()) + "</mi>"
	}}
}

// oper renders simple operators as <mo> elements.
func oper(input, output string) *symbol {
	return &symbol{kindDefault, input, func(*scanner) string { return "<mo>" + output + "</mo>" }}
}

// textOper renders operators as normal text (e.g. and, or, mod), padded with spaces.
func textOper(input string, output ...string) *symbol {
	out := input
	if len(output) > 0 {
		out = output[0]
	}
	return &symbol{kindDefault, input, func(*scanner) string {
		return `<mrow><mspace width="1ex"/><mtext>` + out + `</mtext><mspace width="1ex"/></mrow>`
	}}
}

// underOverOper renders operators that can carry stuff under and over them (e.g.
// sum, lim).
func underOverOper(input string, op ...string) *symbol {
	o := input
	if len(op) > 0 {
		o = op[0]
	}
	return &symbol{kindUnderOver, input, func(*scanner) string { return "<mo>" + o + "</mo>" }}
}

// leftBracket is a left bracket; it also triggers expression parsing. An empty
// output renders nothing (invisible).
func leftBracket(input string, output ...string) *symbol {
	return &symbol{kindLeftBracket, input, bracketRenderer(output)}
}

// rightBracket is a right bracket; it terminates expression parsing. An empty
// output is invisible.
func rightBracket(input string, output ...string) *symbol {
	return &symbol{kindRightBracket, input, bracketRenderer(output)}
}

func bracketRenderer(output []string) parserFunc {
	if len(output) > 0 {
		out := output[0]
		return func(*scanner) string { return "<mo>" + out + "</mo>" }
	}
	return func(*scanner) string { return "" }
}

// ### Unary symbol parsers (commands taking one argument)

// unaryParser handles sin, log, … — operator followed by its argument inside an
// <mrow>, honoring sub/superscripts.
func unaryParser(op string) parserFunc {
	return func(sc *scanner) string {
		sub, sup := subSupParser(sc)
		var soper string
		switch {
		case sub != nil && sup != nil:
			soper = "<msubsup>" + op + *sub + *sup + "</msubsup>"
		case sub != nil:
			soper = "<msub>" + op + *sub + "</msub>"
		case sup != nil:
			soper = "<msup>" + op + *sup + "</msup>"
		default:
			soper = op
		}
		arg := sexprParser(sc)
		return "<mrow>" + soper + arg + "</mrow>"
	}
}

func unary(input string, op ...string) *symbol {
	o := input
	if len(op) > 0 {
		o = op[0]
	}
	return &symbol{kindDefault, input, unaryParser("<mo>" + o + "</mo>")}
}

// unaryEmbed embeds the argument inside a given tag (e.g. sqrt → <msqrt>).
func unaryEmbed(input, tag string) *symbol {
	return &symbol{kindDefault, input, func(sc *scanner) string {
		return "<" + tag + ">" + sexprParser(sc) + "</" + tag + ">"
	}}
}

// unaryUnderOver embeds the argument in a tag together with a hard-coded second
// argument (accents over/under).
func unaryUnderOver(input, tag, arg2 string) *symbol {
	return &symbol{kindUnderOver, input, func(sc *scanner) string {
		return "<" + tag + ">" + sexprParser(sc) + "<mo>" + arg2 + "</mo></" + tag + ">"
	}}
}

// unarySurround surrounds the argument with given left/right brackets (e.g. abs,
// floor).
func unarySurround(input, left, right string) *symbol {
	return &symbol{kindDefault, input, func(sc *scanner) string {
		return "<mrow><mo>" + left + "</mo>" + sexprParser(sc) + "<mo>" + right + "</mo></mrow>"
	}}
}

// unaryAttr embeds the argument in a tag carrying a fixed attribute string (e.g.
// cancel, bb).
func unaryAttr(input, tag, attr string) *symbol {
	return &symbol{kindDefault, input, func(sc *scanner) string {
		return "<" + tag + " " + attr + ">" + sexprParser(sc) + "</" + tag + ">"
	}}
}

// unaryCharTable is a font command: switch the character table on while parsing
// the argument.
func unaryCharTable(input string, table []string) *symbol {
	return &symbol{kindDefault, input, func(sc *scanner) string {
		sc.pushCharTable(table)
		res := sexprParser(sc)
		sc.popCharTable()
		return res
	}}
}

// ### Binary symbol parsers (commands taking two arguments)

// binaryEmbed embeds two arguments inside a tag (e.g. frac → <mfrac>).
func binaryEmbed(input, tag string) *symbol {
	return &symbol{kindDefault, input, func(sc *scanner) string {
		return "<" + tag + ">" + sexprParser(sc) + sexprParser(sc) + "</" + tag + ">"
	}}
}

// binaryAttr uses the first argument as an attribute value read from input, and
// the second as the tag content.
func binaryAttr(input, tag, attr string) *symbol {
	return &symbol{kindDefault, input, func(sc *scanner) string {
		arg1 := sc.nextSymbol().input
		arg2 := sexprParser(sc)
		return "<" + tag + " " + attr + `="` + arg1 + `">` + arg2 + "</" + tag + ">"
	}}
}

// ## Grammar
//
//	v ::= [A-Za-z] | greek letters | numbers | other constant symbols
//	u ::= sqrt | text | bb | other unary symbols for font commands
//	b ::= frac | root | stackrel | other binary symbols
//	l ::= ( | [ | { | (: | {: | other left brackets
//	r ::= ) | ] | } | :) | :} | other right brackets
//	S ::= v | lEr | uS | bSS             Simple expression
//	I ::= S_S | S^S | S_S^S | S          Intermediate expression
//	E ::= IE | I/I                       Expression

// parseSExpr parses a simple expression S. It returns the MathML and the root
// symbol (needed by the I rule).
func parseSExpr(sc *scanner) (string, *symbol) {
	sym := sc.nextSymbol()
	if sym.kind == kindLeftBracket {
		lbrac := sym.parser(sc)
		sym2, _ := sc.peekSymbol()
		exp := ""
		if sym2.kind != kindRightBracket {
			exp = exprParser(sc)
		}
		sym2 = sc.nextSymbol()
		closeSym := sym2
		if sym2.kind != kindRightBracket {
			closeSym = errorSymbol("Missing closing paren")
		}
		rbrac := closeSym.parser(sc)
		return "<mrow>" + lbrac + exp + rbrac + "</mrow>", sym
	}
	return sym.parser(sc), sym
}

func sexprParser(sc *scanner) string {
	res, _ := parseSExpr(sc)
	return res
}

// iexprParser parses an intermediate expression I — attaches
// subscripts/superscripts, under/over for kindUnderOver bases.
func iexprParser(sc *scanner) string {
	res, sym := parseSExpr(sc)
	sub, sup := subSupParser(sc)
	if sym.kind == kindUnderOver {
		switch {
		case sub != nil && sup != nil:
			return "<munderover>" + res + *sub + *sup + "</munderover>"
		case sub != nil:
			return "<munder>" + res + *sub + "</munder>"
		case sup != nil:
			return "<mover>" + res + *sup + "</mover>"
		default:
			return res
		}
	}
	switch {
	case sub != nil && sup != nil:
		return "<msubsup>" + res + *sub + *sup + "</msubsup>"
	case sub != nil:
		return "<msub>" + res + *sub + "</msub>"
	case sup != nil:
		return "<msup>" + res + *sup + "</msup>"
	default:
		return res
	}
}

// subSupParser parses the subscript (_) and superscript (^) expressions, if
// present. A nil result means the script is absent.
func subSupParser(sc *scanner) (*string, *string) {
	var sub, sup *string
	next, p := sc.peekSymbol()
	if next.input == "_" {
		sc.pos = p
		v := sexprParser(sc)
		sub = &v
		next, p = sc.peekSymbol()
	}
	if next.input == "^" {
		sc.pos = p
		v := sexprParser(sc)
		sup = &v
	}
	return sub, sup
}

func isTerminator(k symbolKind) bool {
	switch k {
	case kindEof, kindRightBracket, kindMatrixCellSep, kindMatrixRowSep, kindMatrixRightBracket:
		return true
	}
	return false
}

// exprParser parses an expression E — a sequence of intermediate expressions,
// also handling the / fraction operator.
func exprParser(sc *scanner) string {
	res := ""
	for {
		exp := iexprParser(sc)
		next, pos := sc.peekSymbol()
		if isTerminator(next.kind) {
			return res + exp
		}
		if next.input == "/" {
			sc.pos = pos
			quot := iexprParser(sc)
			exp = "<mfrac>" + exp + quot + "</mfrac>"
			next2, _ := sc.peekSymbol()
			if isTerminator(next2.kind) {
				return res + exp
			}
		}
		res += exp
	}
}

// ## Matrices
//
// This differs from the official AsciiMath syntax: matrices use dedicated
// opening/closing brackets, cells are separated by ; and rows by ;;, which keeps
// parsing simple and unambiguous.
func matrixParser(leftBracket string) parserFunc {
	return func(sc *scanner) string {
		var res strings.Builder
		for {
			sym, pos := sc.peekSymbol()
			if sym.kind == kindEof || sym.kind == kindMatrixRightBracket {
				sc.pos = pos
				rightBracket := sym.parser(sc)
				if leftBracket != "" || rightBracket != "" {
					return "<mrow>" + leftBracket + "<mtable>" + res.String() + "</mtable>" + rightBracket + "</mrow>"
				}
				return "<mtable>" + res.String() + "</mtable>"
			}
			row := matrixRowParser(sc)
			res.WriteString("<mtr>" + row + "</mtr>")
		}
	}
}

func matrixRowParser(sc *scanner) string {
	var res strings.Builder
	for {
		sym, pos := sc.peekSymbol()
		if sym.kind == kindEof || sym.kind == kindMatrixRowSep {
			sc.pos = pos
			return res.String()
		}
		if sym.kind == kindMatrixRightBracket {
			return res.String()
		}
		cell := exprParser(sc)
		res.WriteString("<mtd>" + cell + "</mtd>")
	}
}

func leftMatrix(input string, output ...string) *symbol {
	lb := ""
	if len(output) > 0 {
		lb = "<mo>" + output[0] + "</mo>"
	}
	return &symbol{kindMatrixLeftBracket, input, matrixParser(lb)}
}

func rightMatrix(input string, output ...string) *symbol {
	return &symbol{kindMatrixRightBracket, input, bracketRenderer(output)}
}

func matrixCellSep(input string) *symbol {
	return &symbol{kindMatrixCellSep, input, func(*scanner) string { return "" }}
}

func matrixRowSep(input string) *symbol {
	return &symbol{kindMatrixRowSep, input, func(*scanner) string { return "" }}
}

// ## Symbol Table
//
// Covers all possible inputs except literal strings and numbers. Each
// per-character list is ordered longest-input-first so the scanner matches the
// longest token.
//
// Populated in init() rather than as a plain var initializer: the constructor
// functions build closures that (transitively) call the parser functions, which
// in turn read this map — a reference cycle the compiler rejects for
// package-level variable initializers but not for statements in init().
var symbols map[rune][]*symbol

func init() {
	symbols = map[rune][]*symbol{
		'a': {
			unary("arcsin"), unary("arccos"), unary("arctan"),
			ident("alpha", "&#x03B1;"), oper("aleph", "&#x2135;"),
			unarySurround("abs", "&#124;", "&#124;"), textOper("and"), ident("a"),
		},
		'A': {
			unary("Arcsin"), unary("Arccos"), unary("Arctan"),
			unarySurround("Abs", "&#124;", "&#124;"), oper("AA", "&#x2200;"), ident("A"),
		},
		'b': {
			ident("beta", "&#x03B2;"), unaryUnderOver("bar", "mover", "&#x00AF;"),
			unaryCharTable("bbb", bbbTable), unaryAttr("bb", "mstyle", `style="font-weight: bold"`), ident("b"),
		},
		'B': {ident("B")},
		'c': {
			unaryAttr("cancel", "menclose", `notation="updiagonalstrike"`),
			binaryAttr("color", "mstyle", "mathcolor"), binaryAttr("class", "mrow", "class"),
			oper("cdots", "&#x22EF;"), unarySurround("ceil", "&#x2308;", "&#x2309;"),
			unary("cosh"), unary("csch"), unary("cos"), unary("cot"), unary("csc"),
			ident("chi", "&#x03C7;"), unaryCharTable("cc", calTable), ident("c"),
		},
		'C': {
			unary("Cosh"), unary("Cos"), unary("Cot"), unary("Csc"), oper("CC", "&#x2102;"), ident("C"),
		},
		'd': {
			oper("diamonds", "&#x22C4;"), ident("delta", "&#x03B4;"), oper("ddots", "&#x22F1;"),
			unaryUnderOver("ddot", "mover", ".."), oper("darr", "&#x2193;"), oper("del", "&#x2202;"),
			unary("det"), unaryUnderOver("dot", "mover", "."), textOper("dim"), ident("d"),
		},
		'D': {oper("Delta", "&#x0394;"), ident("D")},
		'e': {
			ident("epsilon", "&#x03B5;"), ident("eta", "&#x03B7;"), unary("exp"), ident("e"),
		},
		'E': {oper("EE", "&#x2203;"), ident("E")},
		'f': {
			unarySurround("floor", "&#x230A;", "&#x230B;"), oper("frown", "&#x2322;"),
			binaryEmbed("frac", "mfrac"), unaryCharTable("fr", frkTable), ident("f"),
		},
		'F': {ident("F")},
		'g': {
			ident("gamma", "&#x03B3;"), oper("grad", "&#x2207;"), unary("gcd"), textOper("glb"), ident("g"),
		},
		'G': {oper("Gamma", "&#x0393;"), ident("G")},
		'h': {
			oper("harr", "&#x2194;"), oper("hArr", "&#x21D4;"),
			unaryUnderOver("hat", "mover", "&#x005E;"), ident("h"),
		},
		'H': {ident("H")},
		'i': {
			ident("iota", "&#x03B9;"), oper("int", "&#x222B;"), oper("in", "&#x2208;"),
			textOper("if"), binaryAttr("id", "mrow", "id"), ident("i"),
		},
		'I': {ident("I")},
		'j': {ident("j")},
		'J': {ident("J")},
		'k': {ident("kappa", "&#x03BA;"), ident("k")},
		'K': {ident("K")},
		'l': {
			ident("lambda", "&#x03BB;"), oper("larr", "&#x2190;"), oper("lArr", "&#x21D0;"),
			underOverOper("lim", "lim"), unary("log"), unary("lcm"), textOper("lub"), unary("ln"), ident("l"),
		},
		'L': {
			oper("Lambda", "&#x039B;"), underOverOper("Lim", "Lim"), unary("Log"), unary("Ln"), ident("L"),
		},
		'm': {
			underOverOper("min"), underOverOper("max"), textOper("mod"), ident("mu", "&#x03BC;"), ident("m"),
		},
		'M': {ident("M")},
		'n': {
			unarySurround("norm", "&#x2225;", "&#x2225;"), underOverOper("nnn", "&#x22C2;"),
			oper("not", "&#x00AC;"), oper("nn", "&#x2229;"), ident("nu", "&#x03BD;"), ident("n"),
		},
		'N': {oper("NN", "&#x2115;"), ident("N")},
		'o': {
			unaryUnderOver("overarc", "mover", "&#x23DC;"), binaryEmbed("overset", "mover"),
			unaryUnderOver("obrace", "mover", "&#x23DE;"), ident("omega", "&#x03C9;"),
			oper("oint", "&#x222E;"), textOper("or"), oper("o+", "&#x2295;"), oper("ox", "&#x2295;"),
			oper("o.", "&#x2299;"), oper("oo", "&#x221E;"), ident("o"),
		},
		'O': {oper("Omega", "&#x03A9;"), oper("O/", "&#x2205;"), ident("O")},
		'p': {
			underOverOper("prod", "&#x220F;"), ident("prop", "&#x221D;"), ident("phi", "&#x03D5;"),
			ident("psi", "&#x03C8;"), ident("pi", "&#x03C0;"), ident("p"),
		},
		'P': {
			oper("Phi", "&#x03A6;"), ident("Psi", "&#x03A8;"), oper("Pi", "&#x03A0;"), ident("P"),
		},
		'q': {
			// quad/qquad emit non-breaking spaces (U+00A0), matching asciimath2ml.
			oper("qquad", "\u00A0\u00A0\u00A0\u00A0"), oper("quad", "\u00A0\u00A0"), ident("q"),
		},
		'Q': {oper("QQ", "&#x211A;"), ident("Q")},
		'r': {
			oper("rarr", "&#x2192;"), oper("rArr", "&#x21D2;"), binaryEmbed("root", "mroot"),
			ident("rho", "&#x03C1;"), ident("r"),
		},
		'R': {oper("RR", "&#x211D;"), ident("R")},
		's': {
			binaryEmbed("stackrel", "mover"), oper("setminus", "&#92;"), oper("square", "&#x25A1;"),
			ident("sigma", "&#x03C3;"), underOverOper("sube", "&#x2286;"), underOverOper("supe", "&#x2287;"),
			unaryEmbed("sqrt", "msqrt"), unary("sinh"), unary("sech"), underOverOper("sum", "&#x2211;"),
			underOverOper("sub", "&#x2282;"), underOverOper("sup", "&#x2283;"), unary("sin"), unary("sec"),
			unaryAttr("sf", "mstyle", `style="font-family: var(--sans-font), sans-serif"`), ident("s"),
		},
		'S': {
			oper("Sigma", "&#x03A3;"), unary("Sinh"), unary("Sin"), unary("Sec"), ident("S"),
		},
		't': {
			ident("theta", "&#x03B8;"), unaryUnderOver("tilde", "mover", "&#126;"),
			unaryEmbed("text", "mtext"), unary("tanh"), unary("tan"), ident("tau", "&#x03C4;"),
			unaryAttr("tt", "mstyle", `style="font-family: var(--mono-font), monospace"`), ident("t"),
		},
		'T': {
			oper("Theta", "&#x0398;"), unary("Tanh"), unary("Tan"), oper("TT", "&#x22A4;"), ident("T"),
		},
		'u': {
			binaryEmbed("underset", "munder"), ident("upsilon", "&#x03C5;"),
			unaryUnderOver("ubrace", "munder", "&#x23DF;"), oper("uarr", "&#x2191;"),
			underOverOper("uuu", "&#x22C3;"), oper("uu", "&#x222A;"),
			unaryUnderOver("ul", "munder", "&#x0332;"), ident("u"),
		},
		'U': {ident("U")},
		'v': {
			ident("varepsilon", "&#x025B;"), ident("vartheta", "&#x03D1;"), ident("varphi", "&#x03C6;"),
			oper("vdots", "&#x22EE;"), unaryUnderOver("vec", "mover", "&#x2192;"),
			underOverOper("vvv", "&#x22C1;"), oper("vv", "&#x2228;"), ident("v"),
		},
		'V': {ident("V")},
		'w': {ident("w")},
		'W': {ident("W")},
		'x': {ident("xi", "&#x03BE;"), oper("xx", "&#x00D7;"), ident("x")},
		'X': {ident("Xi", "&#x039E;"), ident("X")},
		'y': {ident("y")},
		'Y': {ident("Y")},
		'z': {ident("zeta", "&#x03B6;"), ident("z")},
		'Z': {oper("ZZ", "&#x2124;"), ident("Z")},
		'-': {
			oper("__|", "&#x230B;"), oper("-<=", "&#x2AAF;"), oper("->>", "&#x21A0;"), oper("->", "&#x2192;"),
			oper("-<", "&#x227A;"), oper("-:", "&#x00F7;"), oper("-=", "&#x2261;"), oper("-+", "&#x2213;"),
			oper("-", "&#x2212;"),
		},
		'*':  {oper("***", "&#x22C6;"), oper("**", "&#x2217;"), oper("*", "&#x22C5;")},
		'+':  {oper("+-", "&#x00B1;"), oper("+", "&#43;")},
		'/':  {oper("/_\\", "&#x25B3;"), oper("/_", "&#x2220;"), oper("//", "&#47;"), oper("/", "")},
		'\\': {oper("\\\\", "&#92;"), oper("\\", "&#x00A0;")},
		'|': {
			oper("|><|", "&#x22C8;"), oper("|><", "&#x22C9;"), oper("|->", "&#x21A6;"), oper("|--", "&#x22A2;"),
			oper("|==", "&#x22A8;"), oper("|__", "&#x230A;"), leftMatrix("||:", "&#124;"), leftMatrix("|::"),
			oper("|~", "&#x2308;"), leftBracket("|:", "&#124;"), rightMatrix("|)", "&#41;"),
			rightMatrix("|]", "&#93;"), rightMatrix("|}", "&#125;"), oper("|", "&#124;"),
		},
		'<': {oper("<=>", "&#x21D4;"), oper("<=", "&#x2264;"), oper("<<", "&#x226A;"), oper("<", "&#60;")},
		'>': {
			oper(">->>", "&#x2916;"), oper(">->", "&#x21A3;"), oper("><|", "&#x22CA;"), oper(">-=", "&#x2AB0;"),
			oper(">=", "&#x2265;"), oper(">-", "&#x227B;"), oper(">>", "&#x226B;"), oper(">", "&#62;"),
		},
		'=': {oper("=>", "&#x21D2;"), oper("=", "&#61;")},
		'@': {oper("@", "&#x2218;")},
		'^': {underOverOper("^^^", "&#x22C0;"), oper("^^", "&#x2227;"), oper("^", "")},
		'~': {oper("~~", "&#x2248;"), oper("~=", "&#x2245;"), oper("~|", "&#x2309;"), oper("~", "&#x223C;")},
		'!': {oper("!in", "&#x2209;"), oper("!=", "&#x2260;"), oper("!", "&#33;")},
		':': {
			rightMatrix(":||", "&#124;"), rightMatrix("::|"), oper(":=", "&#58;&#61;"),
			rightBracket(":)", "&#x232A;"), rightBracket(":|", "&#124;"), rightBracket(":}", "&#125;"),
			oper(":.", "&#x2234;"), oper(":'", "&#x2235;"), oper(":", "&#58;"),
		},
		';':  {matrixRowSep(";;"), matrixCellSep(";")},
		'.':  {oper("...", "&#46;&#46;&#46;")},
		',':  {oper(",", "&#44;")},
		'_':  {oper("_|_", "&#x22A5;"), oper("_", "")},
		'\'': {oper("'", "&#x2032;")},
		'(':  {leftMatrix("(|", "&#40;"), leftBracket("(:", "&#x2329;"), leftBracket("(", "&#40;")},
		')':  {rightBracket(")", "&#41;")},
		'[':  {leftMatrix("[|", "&#91;"), leftBracket("[", "&#91;")},
		']':  {rightBracket("]", "&#93;")},
		'{':  {leftMatrix("{|", "&#123;"), leftBracket("{:", "&#123;"), leftBracket("{")},
		'}':  {rightBracket("}")},
	}
}
