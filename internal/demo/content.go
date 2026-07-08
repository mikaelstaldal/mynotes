package demo

// This file holds the Markdown source for the demo notes and the inline SVG
// artifact. Notes carrying a %s verb are formatted with an artifact SHA-256 to
// build the image reference (/api/v1/artifacts/{sha256}).

// logoSVGSource is stored as an image/svg+xml artifact and referenced from the
// welcome note. It uses only elements/attributes in the sanitizer allow-list.
const logoSVGSource = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120">
  <rect x="0" y="0" width="240" height="120" rx="12" fill="#eef2ff"/>
  <rect x="24" y="24" width="60" height="72" rx="6" fill="#6366f1"/>
  <line x1="36" y1="44" x2="72" y2="44" stroke="#eef2ff" stroke-width="4"/>
  <line x1="36" y1="60" x2="72" y2="60" stroke="#eef2ff" stroke-width="4"/>
  <line x1="36" y1="76" x2="60" y2="76" stroke="#eef2ff" stroke-width="4"/>
  <text x="104" y="70" font-family="sans-serif" font-size="28" font-weight="bold" fill="#312e81">MyNotes</text>
</svg>
`

// welcomeNote takes the logo artifact SHA.
const welcomeNote = `# Welcome to MyNotes 👋

**MyNotes** is a fast, single-user note manager. Everything you write is stored
as plain [CommonMark](https://commonmark.org/) Markdown and rendered live.

![The MyNotes logo](/api/v1/artifacts/%s)

## What you can do

- Write notes in Markdown with a live preview
- Organize them with **tags** — this note is tagged *Getting Started*
- Search the full text of every note from the sidebar
- Embed images, inline SVG, and even math
- Link between notes to build a personal wiki

> Tip: open the **Markdown Formatting Guide** note to see every supported
> feature with examples you can copy.

## Getting around

The left sidebar always lists your notes. Click **New note** to start writing,
or use the tag filter to narrow things down. Happy note-taking!
`

const markdownGuideNote = "# Markdown Formatting Guide\n" + `
Everything MyNotes supports, in one place. Switch to the editor to see the raw
source alongside this rendered view.

## Text styles

You can write **bold**, *italic*, ***bold italic***, ` + "`inline code`" + `, and
~~strikethrough~~ text. Bare URLs auto-link: https://example.com, and so do
email addresses: hello@example.com.

## Headings

Use ` + "`#`" + ` through ` + "`######`" + ` for the six heading levels.

### A third-level heading

#### A fourth-level heading

## Lists

Unordered, with nesting:

- Fruit
  - Apple
  - Banana
- Vegetables
  - Carrot

Ordered:

1. Preheat the oven
2. Mix the ingredients
3. Bake for 30 minutes

Task lists render as checkboxes:

- [x] Write the note
- [ ] Review it
- [ ] Publish

## Blockquotes

> Not all those who wander are lost.
>
> — J.R.R. Tolkien

## Code blocks

Fenced blocks keep their formatting:

` + "```go" + `
package main

import "fmt"

func main() {
    fmt.Println("Hello, MyNotes!")
}
` + "```" + `

## Tables

| Feature      | Supported | Notes                     |
| ------------ | :-------: | ------------------------- |
| Tables       |    ✅     | GFM pipe tables           |
| Strikethrough|    ✅     | ` + "`~~text~~`" + `                 |
| Autolinks    |    ✅     | bare URLs and emails      |
| Task lists   |    ✅     | ` + "`- [ ]`" + ` and ` + "`- [x]`" + `        |

## Links & rules

Link to [[welcome-to-mynotes|another note]] with the ` + "`[[slug]]`" + ` wikilink
syntax (use ` + "`[[slug|label]]`" + ` for custom text), or to an
[external site](https://commonmark.org/help/). Link to a tag's notes with
` + "`[[#slug]]`" + `, like [[#personal]].

---

That horizontal rule above is written as ` + "`---`" + `.
`

// recipeNote takes the gradient image artifact SHA.
const recipeNote = `# Sourdough Bread 🍞

A reliable everyday loaf with a crisp crust and open crumb.

![A freshly baked loaf](/api/v1/artifacts/%s)

## Ingredients

| Ingredient    | Amount |
| ------------- | -----: |
| Bread flour   |  500 g |
| Water         |  350 g |
| Active starter|  100 g |
| Salt          |   10 g |

## Method

1. **Mix** the flour and water and rest for 30 minutes (autolyse).
2. Add the starter and salt, then fold until combined.
3. **Bulk ferment** for ~4 hours, folding every 30 minutes.
4. Shape, then cold-proof in the fridge overnight.
5. Bake at **250 °C** in a Dutch oven: 20 minutes covered, 20 uncovered.

> Keep a little water in the dough — a wetter dough gives a more open crumb.

Pairs well with the [[weekend-in-lisbon|Weekend in Lisbon]] note's pastéis de nata.

Filed under [[#recipes]] and [[#personal]].
`

// roadmapNote takes the bar-chart image artifact SHA.
const roadmapNote = `# Q3 Project Roadmap

Planning notes for the third quarter. Status is tracked per workstream below.

![Velocity by workstream](/api/v1/artifacts/%s)

## Priorities

1. Ship the new onboarding flow
2. Cut page-load time by 30%%
3. Migrate the reporting pipeline

## Workstream status

| Workstream    | Owner  | Status        |
| ------------- | ------ | ------------- |
| Onboarding    | Ada    | **On track**  |
| Performance   | Linus  | *At risk*     |
| Reporting     | Grace  | Not started   |

## Notes from planning

> We agreed to defer the analytics rebuild to Q4 so the team can focus on the
> onboarding launch.

See the [[markdown-formatting-guide|Markdown Formatting Guide]] for how
these tables are written.
`

const travelNote = `# Weekend in Lisbon 🇵🇹

A two-day itinerary for a first visit.

## Day 1 — Alfama & the waterfront

- Morning: ride **Tram 28** through Alfama's old streets
- Lunch: grilled sardines near the *Time Out Market*
- Afternoon: **São Jorge Castle** for the city views
- Evening: fado music in a small tavern

## Day 2 — Belém

1. Pastéis de nata at the original bakery
2. The **Jerónimos Monastery**
3. Walk out to the **Belém Tower**

## Handy phrases

| Portuguese     | English        |
| -------------- | -------------- |
| Bom dia        | Good morning   |
| Obrigado/a     | Thank you      |
| Quanto custa?  | How much?      |

> Buy a rechargeable *Viva Viagem* card for the trams and metro — it pays for
> itself within a day.

Full trip is tagged [[#travel]] and [[#personal]].
`

const mathNote = "# Math & Diagrams\n" + `
MyNotes renders inline **MathML** and **SVG** embedded directly in Markdown, so
you can drop equations and simple diagrams straight into your notes.

## An equation

The Pythagorean theorem, as MathML:

<math xmlns="http://www.w3.org/1998/Math/MathML">
  <mrow>
    <msup><mi>a</mi><mn>2</mn></msup>
    <mo>+</mo>
    <msup><mi>b</mi><mn>2</mn></msup>
    <mo>=</mo>
    <msup><mi>c</mi><mn>2</mn></msup>
  </mrow>
</math>

And the quadratic formula:

<math xmlns="http://www.w3.org/1998/Math/MathML">
  <mrow>
    <mi>x</mi>
    <mo>=</mo>
    <mfrac>
      <mrow>
        <mo>&#8722;</mo><mi>b</mi>
        <mo>&#177;</mo>
        <msqrt>
          <mrow>
            <msup><mi>b</mi><mn>2</mn></msup>
            <mo>&#8722;</mo>
            <mn>4</mn><mi>a</mi><mi>c</mi>
          </mrow>
        </msqrt>
      </mrow>
      <mrow><mn>2</mn><mi>a</mi></mrow>
    </mfrac>
  </mrow>
</math>

## A diagram

A little inline SVG, drawn with basic shapes:

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 120" width="220" height="120">
  <circle cx="60" cy="60" r="40" fill="#6366f1" fill-opacity="0.6"/>
  <circle cx="120" cy="60" r="40" fill="#22c55e" fill-opacity="0.6"/>
  <text x="90" y="110" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#334155">Overlap</text>
</svg>

Both are validated at write time and safely re-rendered on read.
`
