import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// The sidebar footer's two controls — the light/dark toggle and Settings — are a
// three-repo contract: they are specified to look and sit identically in MyCal,
// MyMail and MyNotes. It is defined in the sibling `mysuite` repository
// (`../mysuite`, `spec/sidebar-footer.md`) and NOT here; § references below are
// to that file. See also the `.sidebar-footer-actions .theme-toggle` block in
// web/static/app.css, which restates the derivations at the code.
//
// Until this file existed, nothing in this repository checked any of it — the
// contract's own §10 item 7 called that "the largest gap", with MyCal's suite
// the only machine-checkable statement of the contract anywhere. This file is
// MyNotes' half.
//
// CI runs this on every push to `main` (see e2e/AGENTS.md;
// `mysuite/spec/sidebar-footer.md` §9.1 is the authority on each app's status).
// The workflow triggers *on* push, so what it gates is publication — a breaking
// commit is already on `main` by the time this goes red.
//
// **And it cannot see MyMail or MyCal.** It shows MyNotes still satisfies the
// contract and says nothing about whether the three still agree; all three
// suites can be green through a divergence. Cross-repo drift is detectable only
// by `mysuite/tools/check-contract.py`, which nobody's CI runs.
//
// Ported from MyCal's e2e/tests/sidebar-footer.spec.ts. Where an assertion is
// kept, its reason is kept with it — these comments record the defect each one
// exists to catch, and a port stripped of them is worth much less than the
// original. Where one is changed or dropped, the comment says what changed and
// why; several of MyCal's numbers are explicitly MyCal-local and copying them
// here would assert a neighbour's rendering (§5.4, §6.2 both warn about exactly
// that, each after it happened).
test.describe('Sidebar footer contract', () => {
  // By class rather than `.first()`/positional: the contract mandates
  // toggle-then-Settings, but a positional locator would silently repoint if a
  // third control ever joined the row and every assertion here would keep
  // passing about the wrong element.
  //
  // MyCal can use one selector for both controls because it gives them one
  // class; MyNotes names them separately (§1 records the local names per app and
  // says they must NOT be unified), so everything below iterates the pair.
  const THEME = '.sidebar-footer-actions .theme-toggle';
  const SETTINGS = '.sidebar-footer-actions .settings-open';
  const BOTH = [THEME, SETTINGS];

  // Both controls exist here because the test server is a real server. In a
  // demo build (`-demo-server` / `-demo-bundle`) Settings is not rendered at all
  // — a demo has no server to hold the MyMail URL — so the pair does not exist
  // and only the toggle is under contract. That is recorded upstream as §10.9,
  // and it is why this suite runs against the real binary rather than the demo.
  const NOTES_API = '/api/v1/notes';

  // ---------------------------------------------------------------------------
  // Content volume — measurement-protocol.md's "the dimension that was missing"
  // ---------------------------------------------------------------------------
  //
  // Every test states the volume it measured at, because a position measured at
  // zero notes and a position measured at forty are different measurements. The
  // contract's §8.2 was added after three apps reported ~100 passing footer
  // measurements that had all been taken against a dataset small enough that no
  // sidebar ever scrolled; with realistic content MyMail's footer went to
  // B = −1052.

  // Delete every note, then PROVE the database is empty rather than assume it.
  // The protocol records a run where the reset command named the wrong file, so
  // three "different volumes" were one volume wearing three hats — and identical
  // numbers across volumes read as stronger evidence than a single measurement
  // while being strictly weaker. A silent no-op reset is the failure mode; this
  // fails loudly instead.
  const resetNotes = async (request: APIRequestContext) => {
    // Loop rather than one pass: `limit` is capped at 200 by openapi.yaml, so a
    // single page would silently under-delete above that and the assertion below
    // would then report "reset left notes behind" — true, but pointing at the
    // wrong cause. Bounded so a delete that does not stick fails as a timeout
    // rather than spinning forever.
    for (let pass = 0; pass < 20; pass++) {
      const list = await request.get(NOTES_API, { params: { limit: 200 } });
      expect(list.ok(), `listing notes for reset: ${list.status()}`).toBe(true);
      const { notes } = await list.json();
      if (notes.length === 0) break;
      for (const note of notes) {
        const gone = await request.delete(`${NOTES_API}/${note.slug}`);
        expect(gone.ok(), `deleting ${note.slug}: ${gone.status()}`).toBe(true);
      }
    }
    const after = await request.get(NOTES_API);
    expect(after.ok()).toBe(true);
    expect((await after.json()).total, 'reset left notes behind').toBe(0);
  };

  const createNote = async (request: APIRequestContext, data: Record<string, unknown>) => {
    const made = await request.post(NOTES_API, { data });
    expect(made.ok(), `creating note: ${made.status()} ${await made.text()}`).toBe(true);
    return made.json();
  };

  // More notes than the list can show, so the sidebar's inner scrollport is
  // genuinely scrolling. 40 is MyMail's number from §8.2, kept so the three
  // suites stress the same volume.
  //
  // **It must stay under the note list's page size**, which is `LIMIT = 50` in
  // web/ts/views/NoteList.tsx: above that the list paginates behind a "Load more"
  // button, and the rendered-row count below would stop matching the API's total.
  // That would fail as though the contract had broken, when the cause is
  // pagination. The volume test asserts the ceiling explicitly so the failure
  // names itself.
  const OVERFLOW_NOTES = 40;
  const LIST_PAGE_SIZE = 50;
  const seedNotes = async (request: APIRequestContext, count: number) => {
    for (let i = 0; i < count; i++) {
      await createNote(request, {
        title: `Volume note ${i} with a reasonably long title`,
        content: `Body of note ${i}.`,
      });
    }
  };

  // A note far taller than any pane, so the *main* content area has to absorb it
  // too. §8.3's measurement of MyNotes used a 400-paragraph note; same here.
  const LONG_NOTE_SLUG = 'long-note';
  const seedLongNote = (request: APIRequestContext) =>
    createNote(request, {
      title: 'Long note',
      slug: LONG_NOTE_SLUG,
      content: Array.from(
        { length: 400 },
        (_, i) => `Paragraph ${i}. ${'lorem ipsum dolor sit amet '.repeat(10)}`,
      ).join('\n\n'),
    });

  // Every test starts from a known, stated volume. Without this the suite would
  // depend on file order for its content volume, which is the same class of
  // mistake as reusing a data directory: it works until it silently does not.
  test.beforeEach(async ({ page, request }) => {
    await resetNotes(request);
    await page.goto('/');
  });

  // Sum the children rather than reading scrollWidth: scrollWidth's behaviour on
  // an `overflow: visible` box is not guaranteed, and this row is one. Comparing
  // the content the row must hold against the width it has is unambiguous
  // everywhere.
  const footerOverflows = (page: Page) =>
    page.locator('.sidebar-footer-actions').evaluate(el => {
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const kids = [...el.children];
      const needed =
        kids.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0) + gap * (kids.length - 1);
      return needed > el.clientWidth + 0.5;
    });

  // Every box this suite measures, in one call. Visibility is asserted first
  // rather than left to the `!`: `boundingBox()` returns null for a missing or
  // hidden element, and a bare non-null assertion turns that into
  // "Cannot read properties of null" at whichever arithmetic touches it first —
  // a message that names neither the element nor the fact that it was absent.
  // `toBeVisible` fails with the selector, which is the difference between a
  // diagnosable red run and a puzzle.
  const boxes = async (page: Page) => {
    for (const selector of [THEME, SETTINGS, '.sidebar']) {
      await expect(page.locator(selector), `${selector} is not visible`).toBeVisible();
    }
    return {
      theme: (await page.locator(THEME).boundingBox())!,
      settings: (await page.locator(SETTINGS).boundingBox())!,
      column: (await page.locator('.sidebar').boundingBox())!,
      viewportHeight: page.viewportSize()!.height,
    };
  };

  // ---------------------------------------------------------------------------
  // Position on screen — the point of the whole exercise. Measured from the
  // window, not from the sidebar: three apps can each be correct against their
  // own container and still put the buttons in three different places, which is
  // exactly what happened before this (§8.1). A user with all three open in tabs
  // must see nothing move when switching between them.
  // ---------------------------------------------------------------------------

  test('controls sit 8px from the window left and bottom edges', async ({ page }) => {
    const { theme, settings, viewportHeight } = await boxes(page);

    // The two numbers that are the MySuite claim. Both font-independent.
    // Measured at zero notes; the overflow tests below re-measure them at 41.
    expect(theme.x).toBeCloseTo(8, 0);
    expect(viewportHeight - (theme.y + theme.height)).toBeCloseTo(8, 0);
    expect(viewportHeight - (settings.y + settings.height)).toBeCloseTo(8, 0);

    // Settings follows the toggle by the 6px gap. Derived from the measured
    // width rather than hardcoded: a literal would pin this machine's system-ui
    // metrics, which §2.4 and §4 both warn are not portable.
    expect(settings.x).toBeCloseTo(theme.x + theme.width + 6, 0);

    // The footer's own left edge, not just the buttons'. §8.5 makes the footer
    // full-bleed across the sidebar, and the sidebar is flush against the window
    // here, so this is 0 — the buttons' 8px is the footer's own padding and
    // nothing else. A horizontal margin added to the footer would keep the
    // buttons at 8 for a while and pull the separator in with them, which is the
    // thing §8.5 prohibits.
    const footer = (await page.locator('.sidebar-footer').boundingBox())!;
    expect(footer.x).toBeCloseTo(0, 0);
  });

  // §8.4. Both coordinates have a hard floor of 4px, and 4 is not slack — it is
  // exactly the clearance the focus outline needs (2px offset + 2px width), so at
  // the floor the margin is zero. It bites only because something clips: MyNotes'
  // .sidebar is `overflow: hidden`, so an L or B below 4 crops the compliant
  // indicator on the window-facing side with nothing erroring and nothing to see
  // but a slightly shorter outline.
  //
  // Asserted separately from (8, 8) above because the two say different things.
  // (8, 8) is the shared position; the floor is what makes a *tighter* value
  // unacceptable, and it is the answer to give if one is ever proposed. MyCal
  // carries no equivalent assertion — its narrow layout sits exactly on the floor
  // at B = 4 (§10.8), so it could only assert the floor and not the 8.
  test('the 4px focus-outline clearance is not consumed, and something does clip', async ({ page }) => {
    const { theme, settings, viewportHeight } = await boxes(page);
    for (const [name, box] of [['toggle', theme], ['settings', settings]] as const) {
      expect(box.x, `${name} L`).toBeGreaterThanOrEqual(4);
      expect(viewportHeight - (box.y + box.height), `${name} B`).toBeGreaterThanOrEqual(4);
    }

    // The premise of the floor, asserted rather than assumed: with no clipping
    // ancestor the outline would simply paint outside the panel and the floor
    // would be pointless. If this ever stops being true the floor above is still
    // correct but is protecting nothing, and it should be re-derived rather than
    // left looking like coverage.
    const clip = await page.locator('.sidebar').evaluate(el => getComputedStyle(el).overflow);
    expect(clip, '.sidebar no longer clips — re-derive §8.4 for this app').not.toBe('visible');
  });

  // §8.5. The separator spans the whole sidebar and the 8px inset comes from the
  // footer's own padding, never a horizontal margin. MyCal's suite asserts only
  // the footer's left edge; this adds the rest, because in MyNotes the footer is
  // deliberately full-bleed where the header and note list above it are inset by
  // 0.75rem, and "tidying" it to match them is the obvious local edit that would
  // break the contract while looking like an improvement.
  test('the separator is full-bleed and the inset comes from padding', async ({ page }) => {
    const footer = await page.locator('.sidebar-footer').evaluate(el => {
      const cs = getComputedStyle(el);
      const sidebar = document.querySelector('.sidebar') as HTMLElement;
      return {
        width: el.getBoundingClientRect().width,
        marginLeft: cs.marginLeft,
        marginRight: cs.marginRight,
        padding: cs.padding,
        borderTopWidth: cs.borderTopWidth,
        borderTopStyle: cs.borderTopStyle,
        // The sidebar's content box: 420px panel less its own 1px border-right.
        // Not the border box — the footer cannot span the border.
        sidebarContentWidth: sidebar.clientWidth,
      };
    });

    expect(footer.marginLeft).toBe('0px');
    expect(footer.marginRight).toBe('0px');
    expect(footer.padding).toBe('8px');
    expect(footer.borderTopStyle).toBe('solid');
    expect(parseFloat(footer.borderTopWidth)).toBeGreaterThan(0);
    expect(footer.width).toBeCloseTo(footer.sidebarContentWidth, 0);
  });

  // B has to be the same in every route. MyCal loops its five *views* here
  // because its month and year views lay out differently from the three that fill
  // the viewport — the page scrolls rather than the column — and without
  // `min-height: 100dvh` its footer landed wherever the grid happened to end.
  //
  // MyNotes has no view switcher, so the equivalent axis is its five routes
  // (router.ts: list, new, view, edit, graph), chosen because they are what
  // changes the main pane's height and scroll behaviour: the note list, an open
  // note, the split editor with its CodeMirror scroller and preview pane, the
  // empty new-note editor, and the graph, which renders a Mermaid SVG and has no
  // scrollport of its own at all. The tag route (/tags/<slug>) is the list route
  // with a filter applied and is not a separate layout, so it is not looped here.
  //
  // This is complete *as of the current route table* and not a claim about
  // "all routes" — §8.3 is explicit that adding a route is the event that
  // invalidates threat-2 coverage, and the new route is then covered by nothing
  // while every route here keeps passing.
  for (const [route, path, ready] of [
    ['list', '/', '.overview-scroll'],
    ['new', '/new', '.editor-page'],
    ['view', `/notes/${LONG_NOTE_SLUG}`, '.note-view-scroll'],
    ['edit', `/notes/${LONG_NOTE_SLUG}/edit`, '.cm-editor'],
    ['graph', '/graph', '.sidebar-graph-wrap--main'],
  ] as const) {
    test(`controls hold (8, 8) on the ${route} route`, async ({ page, request }) => {
      await seedLongNote(request);
      await page.goto(path);
      // Wait for the route's own content, so the measurement is taken against a
      // laid-out page rather than whatever the previous render left behind. A
      // selector that matched nothing would make this a measurement of the
      // shell, which is the shape of failure that reads as a pass.
      await expect(page.locator(ready)).toBeVisible();

      const { theme, settings, column, viewportHeight } = await boxes(page);
      expect(theme.x).toBeCloseTo(8, 0);
      expect(viewportHeight - (theme.y + theme.height)).toBeCloseTo(8, 0);
      expect(viewportHeight - (settings.y + settings.height)).toBeCloseTo(8, 0);
      expect(settings.x + settings.width).toBeLessThanOrEqual(column.x + column.width);
    });
  }

  // §8.2, and the requirement this contract was actually missing. Measured at 41
  // notes plus a 400-paragraph note — not at rest, which is the volume all of
  // MyNotes' previously reported 32 readings used.
  //
  // MyNotes satisfies §8.3 by mechanism A: `.sidebar` is `overflow: hidden` with
  // `.sidebar-content` scrolling inside it and `.sidebar-footer` a sibling of
  // that, so growth is absorbed by the inner scrollport and cannot push the
  // footer. The assertions below are what distinguishes "the footer is outside
  // the scrollport" from "nothing was tall enough to find out": the scroll
  // container's own numbers are asserted first, so a run that loaded the content
  // and then failed to overflow anything fails here rather than reporting a
  // clean pass having stressed nothing.
  test('the footer holds (8, 8) with far more content than the sidebar can show', async ({ page, request }) => {
    await seedNotes(request, OVERFLOW_NOTES);
    await seedLongNote(request);
    await page.goto('/');
    await expect(page.locator('.notes-list-scroll .note-row').first()).toBeVisible();

    // The volume, asserted in the browser and against the API, because they can
    // disagree: the API count is what was stored, the row count is what rendered,
    // and a paginated or filtered list would quietly measure fewer.
    const total = (await (await request.get(NOTES_API)).json()).total;
    expect(total).toBe(OVERFLOW_NOTES + 1);
    // Checked before the row count, so raising OVERFLOW_NOTES past the page size
    // fails here — naming pagination — rather than in the comparison below, where
    // it would read as the list failing to render what was stored.
    expect(total, `seeded past the list's ${LIST_PAGE_SIZE}-note page — the rows below would paginate`)
      .toBeLessThanOrEqual(LIST_PAGE_SIZE);
    expect(await page.locator('.notes-list-scroll .note-row').count()).toBe(total);

    const before = await page.evaluate(() => {
      const list = document.querySelector('.notes-list-scroll') as HTMLElement;
      const sidebar = document.querySelector('.sidebar') as HTMLElement;
      return {
        listScrollHeight: list.scrollHeight,
        listClientHeight: list.clientHeight,
        sidebarScrollHeight: sidebar.scrollHeight,
        sidebarClientHeight: sidebar.clientHeight,
      };
    });

    // The precondition, with numbers rather than an inference from "we loaded a
    // lot of notes".
    expect(before.listScrollHeight,
      `list content ${before.listScrollHeight}px in a ${before.listClientHeight}px box`)
      .toBeGreaterThan(before.listClientHeight);

    // Mechanism A itself: the panel that holds the footer does NOT scroll, at any
    // volume. This is the assertion that would fail if the footer were ever moved
    // inside the scrollport, or if `.sidebar` lost its `overflow: hidden`.
    expect(before.sidebarScrollHeight,
      'the sidebar itself scrolls — the footer is in a scroll flow (§8.3)')
      .toBe(before.sidebarClientHeight);

    // Both extremes of the inner scrollport. A sticky element behaves differently
    // at the top and the bottom of its range; this footer is not sticky, so the
    // expected result is that nothing moves — which is the claim, and it is only
    // worth anything if both ends were actually visited.
    for (const at of ['top', 'bottom'] as const) {
      const scrolled = await page.evaluate(where => {
        const list = document.querySelector('.notes-list-scroll') as HTMLElement;
        list.scrollTop = where === 'top' ? 0 : list.scrollHeight;
        return list.scrollTop;
      }, at);
      if (at === 'bottom') expect(scrolled, 'scrolled nowhere').toBeGreaterThan(0);

      const { theme, settings, viewportHeight } = await boxes(page);
      expect(theme.x, `L at ${at}`).toBeCloseTo(8, 0);
      expect(viewportHeight - (theme.y + theme.height), `B at ${at}`).toBeCloseTo(8, 0);
      expect(viewportHeight - (settings.y + settings.height), `Settings B at ${at}`).toBeCloseTo(8, 0);
    }
  });

  // §8.3 threat 2, the page scrolling. MyCal needs `position: sticky` for its
  // month and year views and has two tests that scroll the document and check
  // the footer stayed on screen. **Those have no MyNotes equivalent**, and the
  // reason is the thing worth pinning: MyNotes is structurally immune, because
  // `html, body { height: 100% }` caps the document at viewport height and
  // `.app-body { flex: 1; min-height: 0; overflow: hidden }` absorbs anything
  // long into an inner scrollport. So the port is not "scroll the page and check
  // the footer" — the page cannot scroll — it is "prove the page still cannot
  // scroll".
  //
  // Worth its own test because that immunity is one word from being lost and
  // nothing else would notice: §8.3 lists `html, body { height: 100% }` as
  // MyNotes' single load-bearing declaration, and relaxing that cap is the sort
  // of edit somebody makes for a good reason, with nothing failing at the time
  // and the consequence appearing later on a short window.
  test('the document itself never scrolls, at every route and at volume', async ({ page, request }) => {
    await seedNotes(request, OVERFLOW_NOTES);
    await seedLongNote(request);

    for (const [route, path, ready] of [
      ['list', '/', '.overview-scroll'],
      ['view', `/notes/${LONG_NOTE_SLUG}`, '.note-view-scroll'],
      ['edit', `/notes/${LONG_NOTE_SLUG}/edit`, '.cm-editor'],
      ['graph', '/graph', '.sidebar-graph-wrap--main'],
    ] as const) {
      await page.goto(path);
      await expect(page.locator(ready)).toBeVisible();

      const m = await page.evaluate(() => {
        const de = document.documentElement;
        // Forced, not merely observed: an unscrolled page and an unscrollable one
        // look identical until you try.
        window.scrollTo(0, 999999);
        const inner = [...document.querySelectorAll<HTMLElement>('*')]
          .filter(el => {
            const oy = getComputedStyle(el).overflowY;
            return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1;
          })
          .map(el => `${el.className.toString().split(' ')[0]} ${el.scrollHeight}/${el.clientHeight}`);
        return {
          docScrollHeight: de.scrollHeight,
          docClientHeight: de.clientHeight,
          bodyScrollHeight: document.body.scrollHeight,
          bodyClientHeight: document.body.clientHeight,
          scrollY: window.scrollY,
          inner,
        };
      });

      expect(m.docScrollHeight, `${route}: document taller than the viewport`).toBe(m.docClientHeight);
      expect(m.bodyScrollHeight, `${route}: body taller than the viewport`).toBe(m.bodyClientHeight);
      expect(m.scrollY, `${route}: the page scrolled`).toBe(0);

      // Distinguish "nothing overflowed" from "the overflow went where it was
      // supposed to go". Without this the three assertions above would pass on an
      // empty database, which is precisely the volume that made this whole class
      // of measurement worthless in the first place. The graph route is the
      // exception and is stated rather than skipped: it renders a Mermaid SVG
      // scaled to its box and legitimately has no scrollport, so there the claim
      // is only that the document does not scroll.
      if (route !== 'graph') {
        expect(m.inner.length, `${route}: nothing was scrolling — this measured nothing`).toBeGreaterThan(0);
      }

      const { theme, viewportHeight } = await boxes(page);
      expect(theme.x, `${route} L`).toBeCloseTo(8, 0);
      expect(viewportHeight - (theme.y + theme.height), `${route} B`).toBeCloseTo(8, 0);
    }
  });

  // ---------------------------------------------------------------------------
  // The pinned declarations
  // ---------------------------------------------------------------------------

  // Geometry assertions only catch a violation that *moves something*, and
  // several of the contract's pins deliberately do not (§3): `font-weight: 400`,
  // `font-style: normal` and `text-align: center` are values the three apps reach
  // by three different routes, and `flex-shrink: 0` does nothing until the row is
  // under pressure. They are pinned because agreement by coincidence is not a
  // contract — an ordinary `button { font-weight: 500 }` in any one repo breaks
  // the match in that repo alone, with nothing anywhere to catch it.
  //
  // §3.1 is the reason this is not the whole story, and the reason the CSSOM test
  // below exists alongside it. Its claim: **the app where a value is already
  // correct is the app whose rendering cannot detect the pin going missing.** In
  // MyCal the UA `button` rule supplies weight, style and centring, so deleting
  // them there changes nothing it can measure. MyNotes reaches them differently —
  // its own `button { font: inherit }` means the UA button *font* never applies,
  // so weight and style come from `body` instead — which is what makes the three
  // agree by coincidence rather than by contract.
  //
  // **Different route, same blind spot here today, and the route was measured
  // rather than reasoned.** Probed in the browser by deleting the pins from the
  // rule and moving `body` to `font-weight: 700; font-style: italic;
  // text-align: right`:
  //
  //   pins present, body moved   → 400 / normal / center   (the pins hold)
  //   pins deleted, body moved   → 700 / italic / center   (weight+style follow body)
  //   pins deleted, body normal  → 400 / normal / center   (all three look correct)
  //
  // So `font-weight` and `font-style` do route through `body` here, as §3
  // describes — but **`text-align` does not**: it is not part of the `font`
  // shorthand, so `font: inherit` never displaces the UA's separate
  // `text-align: center` for buttons, and MyNotes takes it by the same route MyCal
  // does. And with `body` at its normal typography, deleting any of the three
  // changes no computed value at all, so this test stays green for all three —
  // exactly as MyCal's does. Verified by mutation, not assumed: both deletions
  // were applied and only the CSSOM test below went red.
  //
  // Do not read a green run here as covering those pins. It covers the values;
  // the declarations are covered below. What this app *would* see, and MyCal would
  // not, is the day `body` takes a weight or a style — then the pin is the only
  // thing holding the value and this test is what notices.
  test('the pinned declarations resolve to the contract values', async ({ page }) => {
    for (const selector of BOTH) {
      const cs = await page.locator(selector).evaluate(el => {
        const s = getComputedStyle(el);
        return {
          fontSize: s.fontSize, lineHeight: s.lineHeight, fontWeight: s.fontWeight,
          fontStyle: s.fontStyle, textAlign: s.textAlign, flexShrink: s.flexShrink,
          whiteSpace: s.whiteSpace, display: s.display, borderTopWidth: s.borderTopWidth,
          borderRadius: s.borderTopLeftRadius, padding: s.padding, columnGap: s.columnGap,
          alignItems: s.alignItems, cursor: s.cursor,
        };
      });
      // 0.80rem at a 16px root, on a 1.5 line box — the 29.2px acceptance height
      // (§2.2) is these two plus 8px padding and 2px border.
      expect(cs.fontSize, selector).toBe('12.8px');
      expect(cs.lineHeight, selector).toBe('19.2px');
      expect(cs.padding, selector).toBe('4px 8px');
      expect(cs.borderTopWidth, selector).toBe('1px');
      expect(cs.borderRadius, selector).toBe('6px');
      expect(cs.columnGap, selector).toBe('6px');
      expect(cs.alignItems, selector).toBe('center');
      expect(cs.cursor, selector).toBe('pointer');
      // The rule says `inline-flex`; the computed value is `flex` because a flex
      // item's display is blockified. Asserting the computed value, not the
      // declaration — they legitimately differ here.
      expect(cs.display, selector).toBe('flex');
      expect(cs.whiteSpace, selector).toBe('nowrap');
      // The three pinned inherited properties, and the one that keeps overflow
      // rather than a silent squeeze as the failure mode (§2.3).
      expect(cs.fontWeight, selector).toBe('400');
      expect(cs.fontStyle, selector).toBe('normal');
      expect(cs.textAlign, selector).toBe('center');
      expect(cs.flexShrink, selector).toBe('0');
    }

    // The row itself.
    const row = await page.locator('.sidebar-footer-actions').evaluate(el => {
      const s = getComputedStyle(el);
      return { display: s.display, flexWrap: s.flexWrap, columnGap: s.columnGap };
    });
    expect(row.display).toBe('flex');
    expect(row.flexWrap).toBe('nowrap');
    expect(row.columnGap).toBe('6px');
  });

  // Read the rules out of the CSSOM, following @import.
  //
  // **MyNotes needs the recursion and MyCal does not.** app.css opens with
  // `@import url("render/note.css")`, so `document.styleSheets` holds exactly ONE
  // entry here and note.css — which owns `:root`, and therefore `--hover-bg`,
  // `--faint` and `--primary` (§5.2 records that split as a deliberate accepted
  // trade) — is reachable only through `CSSImportRule.styleSheet`. A flat walk
  // over `document.styleSheets`, which is what MyCal's suite does and what a
  // blind port would copy, never enters note.css and returns null for anything
  // in it. **Null from a "was it declared?" probe is indistinguishable from "it
  // was not declared"** — the negative assertion that cannot tell "absent" from
  // "could not look", which measurement-protocol.md spends a section on. Hence
  // `reachedNoteCss` below, asserted in its own test.
  //
  // (This also went wrong in the cross-repo guard, on this very file: its CSS
  // parser merged `@import url("…");` into the rule that followed and dropped
  // that rule, checking nothing and reporting agreement.)
  type ButtonRule = { selectors: string[]; style: Record<string, string> };

  const cssom = (page: Page) =>
    page.evaluate(() => {
      const sheetsSeen: string[] = [];
      let buttonRule: ButtonRule | null = null;
      const roots: Record<string, Record<string, string>> = {};

      const readPalette = (style: CSSStyleDeclaration) => ({
        '--hover-bg': style.getPropertyValue('--hover-bg').trim(),
        '--faint': style.getPropertyValue('--faint').trim(),
        '--primary': style.getPropertyValue('--primary').trim(),
        '--surface': style.getPropertyValue('--surface').trim(),
        '--muted': style.getPropertyValue('--muted').trim(),
        '--border': style.getPropertyValue('--border').trim(),
      });

      const walk = (rules: CSSRuleList) => {
        for (const rule of [...rules]) {
          if (rule instanceof CSSImportRule) {
            // `rule.href` is the URL as authored (`render/note.css`);
            // `rule.styleSheet.href` is the absolute one. Record the resolved
            // form, and record it only when the sheet actually loaded — an
            // @import whose sheet is null is precisely the "could not look" case
            // the caller has to be able to tell apart from "not declared".
            if (rule.styleSheet) {
              sheetsSeen.push(rule.styleSheet.href ?? rule.href);
              walk(rule.styleSheet.cssRules);
            }
            continue;
          }
          if (rule instanceof CSSStyleRule) {
            const selectors = rule.selectorText.split(',').map(s => s.trim());
            if (
              selectors.includes('.sidebar-footer-actions .theme-toggle') &&
              selectors.includes('.sidebar-footer-actions .settings-open')
            ) {
              buttonRule = {
                selectors,
                style: {
                  fontFamily: rule.style.fontFamily,
                  fontWeight: rule.style.fontWeight,
                  fontStyle: rule.style.fontStyle,
                  fontSize: rule.style.fontSize,
                  textAlign: rule.style.textAlign,
                  flexShrink: rule.style.flexShrink,
                  whiteSpace: rule.style.whiteSpace,
                },
              };
            }
            if (rule.selectorText === ':root' || rule.selectorText === ':root[data-theme="dark"]') {
              roots[rule.selectorText] = readPalette(rule.style);
            }
          }
          // Nested rules (@media, @supports, @layer) hold their own list.
          if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
        }
      };

      for (const sheet of [...document.styleSheets]) {
        let rules: CSSRuleList;
        try { rules = sheet.cssRules; } catch { continue; } // cross-origin
        sheetsSeen.push(sheet.href ?? '(inline)');
        walk(rules);
      }
      // Cast on the way out: the assignment happens inside `walk`, which the
      // compiler's control-flow analysis does not follow, so without this it
      // narrows the field to `null` at the return and every property read below
      // is an error against `never`.
      return { sheetsSeen, buttonRule: buttonRule as ButtonRule | null, roots };
    });

  // §3.1 in executable form, and **the only thing in this file that protects
  // `font-weight: 400`, `font-style: normal` or `text-align: center` today.** Both
  // deletions were mutation-tested: the computed-value test above stayed green for
  // each, and this one went red with `Expected: "400"  Received: ""`. That is
  // §3.1's point arriving in the app §3.1 names as the *other* one — the value is
  // already right by another route here too, so the rendering cannot defend it,
  // and reading the declaration is the whole of the coverage.
  //
  // Both tests are kept regardless. The pins exist because three apps reach the
  // same value three ways, so neither form alone covers the reason they exist:
  // this one sees the declaration go, the other sees the value go.
  test('the pinned declarations are actually declared, not inherited', async ({ page }) => {
    const { buttonRule } = await cssom(page);

    expect(buttonRule, 'the sidebar-footer button rule was not found in any stylesheet').not.toBeNull();
    // Exactly the two controls §1 names for this app, and no more: a third
    // selector joining the group would mean a third control took the contract's
    // styling, which is a change to the contract and not a local edit.
    expect(buttonRule!.selectors).toHaveLength(2);

    expect(buttonRule!.style.fontWeight).toBe('400');
    expect(buttonRule!.style.fontStyle).toBe('normal');
    expect(buttonRule!.style.textAlign).toBe('center');
    expect(buttonRule!.style.flexShrink).toBe('0');
    expect(buttonRule!.style.whiteSpace).toBe('nowrap');
    // Inheriting is itself the contract here (§4) — a literal stack would stop
    // these controls following the app's own typography, and it is recorded as a
    // verified shared value rather than a pinned one for exactly that reason.
    expect(buttonRule!.style.fontFamily).toBe('inherit');
    // §2.1's two-decimal form is a convention that NO test can enforce: `0.80rem`
    // and `0.8rem` serialise identically, in the CSSOM as in the rendering, and
    // §9.2 records it as the one item on the silent-breakage list that is held by
    // review alone. So this asserts the value and not the spelling — do not read
    // it as covering the convention.
    expect(buttonRule!.style.fontSize).toBe('0.8rem');
  });

  // The guard on the guard. Everything the previous test asserts is read through
  // a walk that has to enter note.css, and if that walk silently stopped at
  // app.css the palette lookups would return "" — an empty string that compares
  // unequal to any expectation and would look like a real failure, or, worse,
  // that a future assertion written as "not X" would treat as a pass.
  //
  // So assert the walk got there, and that what it found is the palette §5.2 says
  // lives in that file. This is MyNotes-specific and has no MyCal counterpart:
  // MyCal's palette is in its one stylesheet.
  test('the CSSOM walk reaches note.css, where half the palette lives', async ({ page }) => {
    const { sheetsSeen, roots } = await cssom(page);

    expect(sheetsSeen.some(h => h?.endsWith('/render/note.css')),
      `walk never entered note.css; saw ${JSON.stringify(sheetsSeen)}`).toBe(true);

    // §5.2's table, in both themes. Asserted as declarations rather than as
    // resolved colours because that is what this walk is for — the resolved
    // values are pinned by the contrast tests below, against the real backdrop.
    expect(roots[':root'], ':root not found — is note.css still the palette owner?').toBeTruthy();
    expect(roots[':root']['--hover-bg']).toBe('#f3f4f6');
    expect(roots[':root']['--faint']).toBe('#9ca3af');
    expect(roots[':root']['--primary']).toBe('#2563eb');

    expect(roots[':root[data-theme="dark"]'], 'dark palette rule not found').toBeTruthy();
    expect(roots[':root[data-theme="dark"]']['--hover-bg']).toBe('#374151');
    expect(roots[':root[data-theme="dark"]']['--faint']).toBe('#6b7280');
    expect(roots[':root[data-theme="dark"]']['--primary']).toBe('#3b82f6');
  });

  // MyCal additionally asserts that its theme-scoped `[data-theme="dark"]`
  // aliases *name* the shared tokens rather than their current values — a
  // declaration-level check that no rendered value can perform, because collapsing
  // the alias resolves to the same colour today.
  //
  // **Deliberately not ported.** §5.3 says it in as many words: that test exists
  // because MyCal has two recorded per-app deviations (§5.1), both light-only, and
  // "light only" is a claim about token *names* that nothing about the rendering
  // can see. MyMail and MyNotes "need no equivalent because they have no
  // deviations". MyNotes uses the shared value for every role in both themes, so
  // there is no alias here to name anything.
  //
  // What would change that: the day MyNotes is granted a deviation. §5.1's
  // procedure is that a deviation is recorded upstream with its measurement and
  // only then implemented — so if one is ever granted here, this comment is the
  // note that the deviation costs an extra assertion, which is easy to miss when
  // granting one.

  // ---------------------------------------------------------------------------
  // Size and stability
  // ---------------------------------------------------------------------------

  test('controls hold one row and do not move when the theme is toggled', async ({ page }) => {
    const theme = page.getByRole('button', { name: 'Switch to dark mode' });
    await expect(theme).toBeVisible();

    const before = await page.locator(SETTINGS).boundingBox();
    const themeBefore = await theme.boundingBox();

    await theme.click();
    await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();

    const after = await page.locator(SETTINGS).boundingBox();
    const themeAfter = await page.getByRole('button', { name: 'Switch to light mode' }).boundingBox();

    // §7's mechanism — both words stay mounted, stacked in one grid cell — is the
    // one place in this contract where the specific technique is mandated rather
    // than only its effect. toBeCloseTo's second argument is decimal places, so 0
    // is a 0.5px window: loose enough to survive fractional layout, tight enough
    // to catch the "Light" vs "Dark" shift the grid stacking exists to prevent.
    expect(themeAfter!.width).toBeCloseTo(themeBefore!.width, 0);
    expect(after!.x).toBeCloseTo(before!.x, 0);

    // 29.2px at a 16px root font (§2.2) is the height the three apps share.
    // Chromium reports ~29.19. It also clears WCAG 2.5.8's 24×24px target
    // minimum by 5.2px, which is why height is the binding dimension there.
    expect(themeAfter!.height).toBeCloseTo(29.2, 0);
    expect(after!.height).toBeCloseTo(29.2, 0);

    // Side by side, inside the FOOTER's content box — not the column's: the
    // footer is full-bleed while the rest of the sidebar is inset by 0.75rem, so
    // the column's content box is the wrong reference here (§8.5).
    const inner = await page.locator('.sidebar-footer').evaluate(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        left: r.left + el.clientLeft + parseFloat(cs.paddingLeft),
        right: r.left + el.clientLeft + el.clientWidth - parseFloat(cs.paddingRight),
      };
    });
    expect(after!.y).toBeCloseTo(themeAfter!.y, 0);
    expect(themeAfter!.x).toBeGreaterThanOrEqual(inner.left);
    expect(after!.x + after!.width).toBeLessThanOrEqual(inner.right);
  });

  // The row is nowrap and the buttons do not shrink, so a wider font overflows
  // rather than reflowing — and the only font anyone measures here is this
  // container's. This turns the CSS's slack claim into an assertion, since the
  // overflow branch is otherwise never exercised.
  //
  // 1.1x, not the ratio where it actually breaks: the point is to prove the slack
  // is real, not to pin how much of it there is. The row's width is text in
  // whatever system-ui resolves to, which §4 warns is not portable — so an
  // assertion sitting near the boundary would be pinning exactly the number that
  // warning says not to trust.
  //
  // **Weak evidence in this app, and worth saying so.** §2.4: MyNotes has 403px
  // of content box for a 174px row — ~229px of slack, against MyCal's 26px and
  // MyMail's 29px. This passes here by a factor the other two do not have, so a
  // green result is close to guaranteed and is not evidence that the row is
  // tight enough to be worth watching. It is here for parity and to catch a
  // change that removes the slack outright, not because it is discriminating.
  test('the row absorbs a 10% wider font without overflowing', async ({ page }) => {
    const measure = () =>
      page.locator('.sidebar-footer-actions').evaluate(el => {
        const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
        const kids = [...el.children];
        return {
          needed: kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0) + gap * (kids.length - 1),
          available: el.clientWidth,
        };
      });

    const before = await measure();
    expect(before.needed, `pair ${before.needed} in ${before.available}`).toBeLessThanOrEqual(before.available);

    await page.locator(`${THEME}, ${SETTINGS}`).evaluateAll(els => {
      for (const el of els) {
        (el as HTMLElement).style.fontSize =
          parseFloat(getComputedStyle(el).fontSize) * 1.1 + 'px';
      }
    });

    const after = await measure();
    // Reported either way, so a failure says how far over rather than just "red".
    expect(after.needed, `at 1.1x font: pair ${after.needed} in ${after.available}`)
      .toBeLessThanOrEqual(after.available);
  });

  // WCAG 1.4.4 Resize Text: the buttons are sized in rem and grow with the
  // reader's browser font, so they must still fit. 20px is Chrome's "Large"
  // setting, reachable from the browser's own menu; 24px is 150%.
  //
  // **MyNotes' column is `px` and that is a sanctioned exemption, not drift**
  // (§6.4). MyCal and MyMail converted theirs to rem because they have ~26px and
  // ~29px of slack and a px column would push Settings out. MyNotes has ~229px,
  // so the resize case never binds — and converting would be a *regression*:
  // 420px becomes 26.25rem, which at a 24px root is a 630px sidebar that eats the
  // note list for no benefit. So do not read a failure here as "convert the
  // column"; read it as the row having grown or the slack having gone.
  //
  // Same caveat as the 1.1x test: at a 24px root the row reaches 217px against
  // 403px available. Comfortable margins are a weak result here, not a strong one.
  for (const root of [20, 24]) {
    test(`controls stay inside the column at a ${root}px root font`, async ({ page }) => {
      // Set through the CSSOM rather than addStyleTag — the app's CSP has no
      // 'unsafe-inline' in style-src, so an injected <style> is rejected.
      await page.evaluate(r => { document.documentElement.style.fontSize = `${r}px`; }, root);

      const { theme, settings, column, viewportHeight } = await boxes(page);
      expect(column.width).toBeCloseTo(420, 0);
      expect(settings.x + settings.width).toBeLessThanOrEqual(column.x + column.width);
      expect(await footerOverflows(page)).toBe(false);

      // The buttons grow with the font, so their height moves off 29.2 — but
      // their position must not. This is the assertion that a bigger root font
      // would otherwise quietly break, since the row is anchored from the bottom.
      expect(theme.x).toBeCloseTo(8, 0);
      expect(viewportHeight - (theme.y + theme.height)).toBeCloseTo(8, 0);

      // Growing the column must not push the page into a horizontal scroll —
      // that would be the same 1.4.4 failure moved one row up.
      const hScroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hScroll).toBe(false);
    });
  }

  // MyCal's counterpart asserts `.mini-month` is hidden below 600px, where its
  // `.app` padding drops to 4px and the sidebar stacks under the main content.
  //
  // **MyNotes has no breakpoint at all** — `grep '@media' web/static/*.css` finds
  // nothing — so there is nothing hidden to assert and no narrow layout to
  // survive. The 420px sidebar simply stays 420px and `.app-body`'s
  // `overflow: hidden` clips whatever does not fit. The consequence for this
  // contract is a *stronger* result than MyCal's: both coordinates hold at
  // (8, 8) at a phone width, where MyCal manages only L = 8 with B = 4 (§10.8).
  //
  // Declared blind spots, in MyCal's style, because §9.2 records a real breakage
  // that hid in exactly the axis its narrow-layout test had documented as out of
  // scope — a documented blind spot is still a blind spot:
  //   * The main pane is measured at 48px wide at 375px and is effectively
  //     unusable. That is outside this contract, which covers two controls, and
  //     is NOT asserted here in either direction.
  //   * Nothing here would notice a breakpoint being *added*. If one ever is, the
  //     (8, 8) assertions below are what it has to keep satisfying, and whatever
  //     it hides needs its own assertion — this test cannot grow one by itself.
  test('the contract holds unchanged at a phone width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });

    await expect(page.locator('.sidebar-footer')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible();
    await expect(page.locator(SETTINGS)).toBeVisible();

    const { theme, settings, viewportHeight } = await boxes(page);
    expect(theme.x).toBeCloseTo(8, 0);
    expect(viewportHeight - (theme.y + theme.height)).toBeCloseTo(8, 0);
    expect(viewportHeight - (settings.y + settings.height)).toBeCloseTo(8, 0);
    expect(await footerOverflows(page)).toBe(false);

    // Still usable, not just present.
    await page.locator(SETTINGS).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Colour
  // ---------------------------------------------------------------------------

  // The colour actually painted behind a control: walk up to the first ancestor
  // with a non-transparent background.
  //
  // **This is the method the contract names (§5.3), and in MyNotes it is the only
  // one that works.** Reading `.sidebar-footer`'s own `backgroundColor` — which
  // is what a test written against MyCal's or MyMail's structure does, because
  // both of those footers declare one — returns `rgba(0, 0, 0, 0)` here: MyNotes'
  // footer is transparent and `.sidebar` paints `--surface` behind it. Every
  // contrast figure derived from that would be computed against transparency
  // while looking entirely plausible. §5.3 records that an earlier version of the
  // contract said "the footer paints --surface", which was false of this app, and
  // that a guard implementing the literal wording would have failed a correct
  // implementation.
  //
  // Starts at the PARENT: an element's own background is not its backdrop.
  // Starting at the button is correct today only because these carry
  // `background: none`, so the loop would walk straight past them — nothing in
  // the contract guarantees that. Used in a hover context it would return the
  // button's own fill as the "backdrop" and every figure derived from it would be
  // wrong. Not hypothetical: an earlier version of MyCal's file did start at
  // `el`, and the first measurement taken after it was fixed came back different,
  // because clicking the theme toggle leaves the pointer on it.
  //
  // Limitations, per measurement-protocol.md, and the two that can be
  // *confidently wrong* are the ones to know: (1) it detects `background-color`
  // only, so a gradient or background-image ancestor is walked straight past;
  // (2) a semi-transparent colour is treated as opaque, so the value returned is
  // the painter rather than the composite. Neither applies to this footer today —
  // `.sidebar`'s `background: var(--surface)` is a flat opaque colour — and both
  // would produce a confident wrong number rather than a null if that changed.
  const backdropOf = (page: Page, selector: string) =>
    page.locator(selector).first().evaluate(el => {
      for (let n: Element | null = el.parentElement; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      }
      // Distinguishable from a colour, deliberately: a walk that finds nothing
      // must not fall through to a default, or it becomes a run that measured
      // nothing and looks like a pass. Null is "could not determine", never
      // "agrees" — the canvas is white by default, which is a different claim.
      return null;
    });

  // Resolve a custom property to the same rgb() form getComputedStyle reports for
  // a background, so token and measurement can be compared without a hex/rgb
  // conversion in the test. Reading the property off :root gives "#f9fafb", which
  // never equals "rgb(249, 250, 251)" and would make an equality assertion fail
  // for a reason that has nothing to do with the contract.
  const tokenColor = (page: Page, name: string) =>
    page.evaluate(n => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = `var(${n})`;
      document.body.appendChild(probe);
      const v = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return v;
    }, name);

  const useDarkTheme = async (page: Page) => {
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();
    // The click leaves the pointer sitting on the toggle, so any colour read from
    // a footer control afterwards is read in its HOVER state. Every resting
    // figure below would then be measured against the wrong thing while looking
    // entirely reasonable. Move the pointer off before measuring anything.
    await page.mouse.move(0, 0);
    // Then let the colour transition finish. Swapping the theme re-resolves the
    // tokens under a 0.12s transition, so the buttons spend that long reporting a
    // blend of the two palettes. See settledStyle.
    await settledStyle(page, SETTINGS, 'color');
  };

  // These buttons carry `transition: background 0.12s, color 0.12s,
  // border-color 0.12s` — mandated by §6.1, so it cannot be removed to make
  // measuring easier, and it takes no `prefers-reduced-motion` guard either
  // (§6.1 is a standing ruling on that: it animates colour only). Every one of
  // those three properties therefore reports an intermediate value for 120ms
  // after anything that changes it, and the intermediate values are ordinary
  // colours that look entirely plausible.
  //
  // This is not a theoretical hazard: in MyCal, reading the label colour straight
  // after the theme toggle returned the *light* theme's resting value against a
  // dark backdrop, for 2.347:1 and a failing assertion that pointed at the
  // palette instead of at the clock. Note what did not catch it — the test
  // already asserted the element was not hovered, and it genuinely was not. The
  // state was right and the timing was wrong.
  //
  // **It matters more here than it did there.** §5.4: MyNotes' light resting
  // label clears 4.5:1 by 0.126 — the narrowest margin of the three, MyCal has
  // room and MyMail clears by 0.334 — so a reading taken mid-transition does not
  // merely produce a wrong number, it flips the verdict.
  //
  // So poll until two consecutive reads agree, rather than sleeping a guessed
  // interval, and throw if it never settles. A timeout that returned the last
  // value read would be a measurement of the transition reported as a measurement
  // of the colour — the same failure, quieter. Two equal reads are necessary but
  // not sufficient on their own: the transition interpolates in 8-bit channels,
  // so a slow segment can serialise to the same rgb() twice in a row while still
  // running. So also require that no transition is in flight — getAnimations()
  // reports CSS transitions, and an element with none pending returns an empty
  // list, which is the ordinary case here.
  const settledStyle = async (page: Page, selector: string, prop: 'color' | 'backgroundColor') => {
    const read = () =>
      page.locator(selector).first().evaluate(
        (el, p) => ({
          value: getComputedStyle(el)[p as 'color' | 'backgroundColor'],
          running: el.getAnimations().length,
        }),
        prop,
      );
    let prev = await read();
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(25);
      const now = await read();
      if (now.value === prev.value && now.running === 0) return now.value;
      prev = now;
    }
    throw new Error(`${prop} of ${selector} never settled`);
  };

  // WCAG 1.4.11 (AA) wants 3:1 between the focus indicator and the colours next
  // to it. Asserting the indicator merely *exists* is not enough — the
  // translucent ring the contract first called for existed too, and measured
  // 1.28:1 light / 1.50:1 dark (§11). So compute the real contrast, and check the
  // outline is offset clear of the button's own border: drawn tight against it
  // the neighbour is --border, which caps dark at 2.803:1 and no opacity value
  // can lift it.
  const relLum = (rgb: [number, number, number]) => {
    const f = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const contrast = (a: [number, number, number], b: [number, number, number]) => {
    const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const parseRgb = (s: string): [number, number, number] => {
    const m = s.match(/\d+(\.\d+)?/g)!;
    return [Number(m[0]), Number(m[1]), Number(m[2])];
  };

  // Chromium withholds :focus-visible from a programmatic focus() when the last
  // interaction was a pointer, which would make every assertion below vacuous.
  // Establish keyboard modality, then assert the element really matched — so
  // this fails loudly rather than silently if that ever stops holding.
  const focusAndRead = async (page: Page, selector: string) => {
    await page.keyboard.press('Tab');
    const s = await page.locator(selector).first().evaluate(el => {
      (el as HTMLElement).focus();
      const cs = getComputedStyle(el);
      return {
        focusVisible: el.matches(':focus-visible'),
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineOffset: cs.outlineOffset,
        outlineColor: cs.outlineColor,
      };
    });
    return { ...s, backdrop: await backdropOf(page, selector) };
  };

  for (const dark of [false, true]) {
    const mode = dark ? 'dark' : 'light';

    // §6.2. MyNotes measures 4.946:1 light and 3.991:1 dark against its own
    // backdrop. Those numbers are NOT asserted as literals — the threshold is,
    // because the contract's threshold is what binds and its own table warns
    // twice against transcribing a neighbour's figure (a reviewer once produced
    // MyCal's light figure as 4.90 where the true value was 5.169, and the
    // mechanism was never determined). Recompute; do not transcribe.
    //
    // Dark has about one point of headroom here and it is shared with MyMail —
    // both dark backdrops are #1f2937, so any change to --surface in dark, or to
    // --primary, moves both at once from a margin neither can spend.
    test(`focus indicator meets 3:1 against its backdrop in ${mode} mode`, async ({ page }) => {
      if (dark) await useDarkTheme(page);

      for (const selector of BOTH) {
        const s = await focusAndRead(page, selector);
        expect(s.focusVisible, selector).toBe(true);

        // Guard both parses: an rgba()/oklch()/color() value would fall out of
        // parseRgb as something bogus and could produce a meaningless pass.
        // null means the walk found nothing opaque, which is a broken measurement
        // rather than a failing one — distinguish it from a bad colour value.
        expect(s.backdrop, `${selector}: no opaque backdrop found above the control`).not.toBeNull();
        expect(s.backdrop, selector).toMatch(/^rgb\(/);
        expect(s.outlineColor, selector).toMatch(/^rgb\(/);
        // Never restore `outline: none` (§6.2, §11): the box-shadow ring it was
        // paired with existed and could not be seen.
        expect(s.outlineStyle, selector).toBe('solid');
        // Never shrink the 2px width — that is exactly the minimum indicator area
        // WCAG 2.4.13 accepts.
        expect(parseFloat(s.outlineWidth), selector).toBeGreaterThanOrEqual(2);
        // Offset clear of the button's border — this is what lifts dark past 3:1.
        // 1px would also break the adjacency; 2px is chosen for robustness against
        // fractional device-pixel ratios, so this is the contract's value and not
        // the mechanism's minimum.
        expect(parseFloat(s.outlineOffset), selector).toBeGreaterThanOrEqual(2);
        expect(
          contrast(parseRgb(s.outlineColor), parseRgb(s.backdrop!)),
          `${selector}: outline ${s.outlineColor} on ${s.backdrop}`,
        ).toBeGreaterThanOrEqual(3);
      }
    });

    // §5.3. MyNotes' recorded backdrop is `--surface`: #f9fafb light, #1f2937
    // dark. Asserted against the token rather than a literal so the palette stays
    // the single source of the value — the ratios below are what pin the value
    // itself.
    //
    // The three apps are accepted to differ here and each one's value is recorded
    // upstream; MyCal's is `--bg`, MyMail's is `--surface` but a different white.
    // So this is MyNotes' row of that table and nothing more — a figure copied
    // from a sibling would be wrong in a way that looks checked.
    //
    // This equality is discriminating, which is worth stating because §5.4's
    // lesson is that a coincidence between two surfaces hides a *method* error
    // rather than a value error: here `--bg` is #ffffff light and #111827 dark
    // against `--surface`'s #f9fafb and #1f2937, so the two never coincide in
    // either theme and painting the wrong one fails this. MyCal has to assert
    // `not.toBe(--surface)` separately for want of that separation.
    test(`controls sit on the sidebar panel's --surface in ${mode} mode`, async ({ page }) => {
      if (dark) await useDarkTheme(page);
      for (const selector of BOTH) {
        const backdrop = await backdropOf(page, selector);
        expect(backdrop, `${selector}: no opaque backdrop found above the control`).not.toBeNull();
        expect(backdrop, selector).toBe(await tokenColor(page, '--surface'));
      }
    });

    // WCAG 1.4.3 (AA). The label is 12.8px at weight 400 — normal text, so the
    // threshold is 4.5:1 and not the 3:1 large-text allowance.
    //
    // §5.4: this app clears 4.5:1 by **0.126** in light (#6b7280 on #f9fafb =
    // 4.626:1), the narrowest margin of the three. It is sensitive to any change
    // in its backdrop or in the shared label colour, and it is one of the two
    // rows §10.2 names as where the 4.393:1 failure that has already shipped
    // twice in MyCal would surface next.
    test(`resting label meets 4.5:1 against its backdrop in ${mode} mode`, async ({ page }) => {
      if (dark) await useDarkTheme(page);
      for (const selector of BOTH) {
        // Assert the state that was measured, not just the number: the resting
        // colour and the hover colour are different declarations, and reading one
        // while believing it is the other passes for the wrong reason. Necessary
        // and not sufficient — it says nothing about the transition, so the colour
        // itself is read through settledStyle.
        const hovered = await page.locator(selector).evaluate(el => el.matches(':hover'));
        expect(hovered, `${selector}: measured in the hover state — this is not the resting colour`).toBe(false);
        const color = await settledStyle(page, selector, 'color');
        const backdrop = await backdropOf(page, selector);
        expect(backdrop, `${selector}: no opaque backdrop found above the control`).not.toBeNull();
        expect(color, selector).toMatch(/^rgb\(/);
        expect(backdrop, selector).toMatch(/^rgb\(/);
        expect(
          contrast(parseRgb(color), parseRgb(backdrop!)),
          `${selector}: label ${color} on ${backdrop}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    // There is no WCAG threshold for a hover fill and §5.1's floor is a *product*
    // floor, reverse-engineered from the status quo: it forbids only getting
    // worse than the worst. **MyNotes' light fill IS the worst** — #f3f4f6 on
    // #f9fafb, 1.053:1 — so this app is the source of that floor rather than
    // merely a satisfier of it, and §5.1 records that the floor was first written
    // at 1.101 (MyCal's and MyMail's figure) and had to be corrected because
    // MyNotes fails it.
    //
    // So this asserts what MyCal's does and no more: that the fill differs from
    // its backdrop and scores above 1. That framing is the safe one, and asserting
    // a floor of 1.053 here would be pinning this app's current rendering as a
    // contract value from the wrong side. What is unambiguously broken is a fill
    // the same colour as what it is drawn on — MyCal shipped exactly that at
    // 1.000:1, its --hover-bg and --bg both being #f3f4f6.
    //
    // §10.1 is the standing caveat: the fill does almost no visual work in any of
    // the three, clearing this floor is not evidence that hover is visible, and
    // raising it is a suite-wide design change that must not be made in one app.
    // Hover stays clearly signalled here by the border and text, which both move.
    test(`hover fill is distinguishable from its backdrop in ${mode} mode`, async ({ page }) => {
      if (dark) await useDarkTheme(page);
      for (const selector of BOTH) {
        // Read the backdrop BEFORE hovering. The walk starts at the parent so it
        // is hover-safe by construction, but taking it first means the assertion
        // does not depend on that remaining true.
        const backdrop = await backdropOf(page, selector);
        expect(backdrop, `${selector}: no opaque backdrop found above the control`).not.toBeNull();

        await page.locator(selector).hover();
        const fill = await settledStyle(page, selector, 'backgroundColor');
        // Guards the vacuous pass: with the hover rule gone the button keeps
        // `background: none` and reads rgba(0, 0, 0, 0), which parses to black and
        // would score a huge ratio against a light backdrop. rgb( excludes it.
        expect(fill, `${selector}: no opaque hover fill — did the hover rule apply?`).toMatch(/^rgb\(/);
        expect(fill, `${selector}: hover fill is the same colour as its backdrop`).not.toBe(backdrop);
        expect(
          contrast(parseRgb(fill), parseRgb(backdrop!)),
          `${selector}: fill ${fill} on ${backdrop}`,
        ).toBeGreaterThan(1);
        await page.mouse.move(0, 0);
      }
    });
  }

  // MyCal has a test called "the footer paints an opaque background of its own",
  // and **it must not be ported.** Its footer is sticky for the month and year
  // views, so content scrolls under it and an opaque background is mandatory
  // there; MyMail's is the same for its scrolling sidebar. §5.3 states plainly
  // that both are load-bearing in a way MyNotes' "cannot be, even in principle" —
  // this footer is transparent and inherits `.sidebar`'s paint, which is a
  // sanctioned way to satisfy §5.3 and would fail MyCal's assertion outright.
  //
  // The obligation it serves is covered instead by the two assertions that
  // actually apply here: the resolved *backdrop* is opaque and equals the
  // recorded value (the `--surface` tests above, via the ancestor walk §5.3
  // names), and the footer is outside every scrollport so nothing can scroll
  // under it (the two §8.2/§8.3 tests above). Between them they cover what
  // MyCal's single test covers there.
  //
  // What would change that: giving this footer `position: sticky`, or moving it
  // inside a scrolling ancestor. Either turns the opaque background from
  // unnecessary into mandatory, and this app would then need MyCal's assertion
  // too. §8.3 is explicit that forcing sticky here would add a stacking context,
  // an opaque background and a bottom/padding-bottom interaction to a footer that
  // already satisfies §8.2 structurally — three new ways to be wrong in exchange
  // for nothing measurable.

  // An outline is painted under forced colours; a box-shadow is not, which is why
  // the ring the contract first called for would have needed a media-query patch.
  // The base rule carries the outline, so there is nothing theme-specific here.
  //
  // Note the *absence* this also protects: §6.2 forbids adding a
  // `@media (forced-colors: active)` block back, because one containing
  // `outline: revert` would override this compliant outline with the UA default —
  // silently undoing the fix it looks like it is protecting. This test would not
  // catch `outline: revert` (the UA outline is still an outline), so that
  // prohibition is held by review; what this catches is the indicator vanishing.
  test('controls keep a focus indicator under forced colors', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    for (const selector of BOTH) {
      const s = await focusAndRead(page, selector);
      expect(s.focusVisible, selector).toBe(true);
      expect(s.outlineStyle, selector).not.toBe('none');
      expect(parseFloat(s.outlineWidth), selector).toBeGreaterThan(0);
    }
  });
});
