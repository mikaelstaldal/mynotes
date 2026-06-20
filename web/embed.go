// Package web embeds the compiled frontend assets into the binary so the
// deployed artifact is a single executable. The TypeScript sources in web/ts/
// are compiled to web/static/ by tsc (see build.sh) before this is built.
package web

import "embed"

//go:embed all:static
var Static embed.FS
