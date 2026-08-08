// MyNotes' own app mark: the "N" from web/static/favicon.svg, on the --primary
// square that .brand-logo paints. The path data is character-for-character the
// favicon's; `currentColor` replaces its `#fff` so the mark inherits the badge's
// foreground, the way MyCal and MyMail draw theirs.
//
// **Two intended differences from favicon.svg, and only two:**
//
//  1. The favicon's background <rect> is absent here — .brand-logo paints the
//     square in --primary, so drawing it again would put a fixed light-mode blue
//     inside a themed box and the badge would stop following the dark theme.
//  2. The viewBox crops to the letter (`10 10 12 12`) instead of spanning the
//     favicon's full `0 0 32 32`. Same reason: the favicon's 32-unit box exists
//     to hold its own rounded square, and the N is inset within it. Here the
//     square is the CSS box, so the glyph box must frame the letter alone.
//
// That crop is load-bearing, not tidying. The shared logo contract sets a floor
// on how much of the glyph box the mark's ink must span, and the favicon's N
// fills only 9.9 x 11 of its 32-unit viewBox — 30.9% x 34.4%, which fails it.
// Dropped into the badge uncropped it renders 5.26 x 5.84px inside a 17px glyph
// box: about a third the apparent size of MyCal's mark, in an identically-sized
// badge. Measured, not estimated, and it is invisible to any check that pins
// only the badge box and the glyph box.
//
// `10 10 12 12` frames the letter's 9.9 x 11 bounding box with ~1 unit of margin
// and puts the ink at 91.67% of the glyph box on its larger axis (the height) —
// comfortably clear of the floor rather than sitting on it.
//
// **Any change to the letterform belongs in favicon.svg too, and vice versa.**
// The two must stay the same picture; the crop and the fill are the only things
// that may differ. It lives here rather than in <Icon> because it is not a
// Lucide icon and is not in the vendored bundle — do not route it through
// gen-lucide.mjs.
//
// Size comes from CSS (`.brand-logo svg`), so the badge's box and its contents
// are sized in one place.

// `fill="none"` on the root is the sibling apps' convention and is inert here,
// since the one path sets its own fill — but it means a path added later without
// an explicit `fill` renders invisible rather than black. Give every path an
// explicit fill.
export function Logo() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="10 10 12 12" fill="none" aria-hidden="true">
      <path d="M11.1 21.5V10.5h2.4l5.3 7.7V10.5h2.2v11h-2.4l-5.3-7.7v7.7z" fill="currentColor" />
    </svg>
  );
}
