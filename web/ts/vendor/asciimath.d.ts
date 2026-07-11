// Type declaration for the vendored asciimath2ml bundle
// (web/static/vendor/asciimath.js). The upstream library exposes a single
// function that converts an AsciiMath (https://asciimath.org) expression to a
// MathML string. `inline` selects inline vs. display style; when omitted the
// output is display (block).
export declare function asciiToMathML(
  input: string,
  inline?: boolean,
  escapePunctuation?: boolean,
): string;
