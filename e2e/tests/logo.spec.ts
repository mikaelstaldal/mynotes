import { test, expect, type Page } from '@playwright/test';

// The brand badge at the top left of the sidebar is a three-repo contract: the
// marks in MyCal, MyMail and MyNotes are specified to render at the same size
// and sit in the same place. It is defined in the sibling `mysuite` repository
// (`../mysuite`, `spec/`) and NOT here. See also the `.brand-logo` block in
// web/static/app.css and the section "The app logo is governed from outside this
// repo" in web/AGENTS.md.
//
// This file is MyNotes' half. Like sidebar-footer.spec.ts it cannot see the
// other two apps: it shows MyNotes still satisfies the contract and says nothing
// about whether the three still agree.
//
// Everything here is MEASURED on a rendered page rather than read off an
// attribute or a prop — the contract's own wording is "renders at 17x17", never
// "the attribute says 17", because a CSS rule can silently override either
// mechanism. `.brand-logo svg` is exactly such a rule in this app.
test.describe('Brand logo contract', () => {
  const BADGE = '.sidebar-brand .brand-logo';
  const BRAND = '.sidebar-brand';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator(BADGE)).toBeVisible();
  });

  const darkMode = async (page: Page) => {
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(page.locator('html[data-theme="dark"]')).toHaveCount(1);
  };

  const geometry = (page: Page) => page.evaluate(() => {
    const badge = document.querySelector('.sidebar-brand .brand-logo') as HTMLElement;
    const svg = badge.querySelector('svg') as SVGSVGElement;
    const path = badge.querySelector('path') as SVGPathElement;
    const brand = document.querySelector('.sidebar-brand') as HTMLElement;
    const b = badge.getBoundingClientRect();
    const g = svg.getBoundingClientRect();
    // The rendered INK, not the glyph box — this is what the extent floor is
    // about, and the two differ by however much padding the viewBox carries.
    const ink = path.getBoundingClientRect();
    const bCS = getComputedStyle(badge);

    // The label text, found ANYWHERE under the anchor — one search, shared by
    // every label reading below.
    //
    // Deep, not `brand.childNodes`, and that is the whole point. With a
    // direct-child search `labelParentIsAnchor` cannot be false: a node found
    // that way has the anchor as its parent by construction, and a node not
    // found falls back to the anchor anyway. It read as a guard and was a
    // tautology — the shape spec/measurement-protocol.md calls a guard that
    // lies toward a pass. Searching deeply separates the two states it was
    // meant to distinguish: "there is no label" (labelFound) from "the label
    // moved into a wrapper" (labelParentIsAnchor).
    //
    // The badge contributes no text — its <svg> holds none — so the first
    // non-blank text node under the anchor is the label.
    const labelNode = (() => {
      const walk = document.createTreeWalker(brand, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        if ((walk.currentNode.textContent ?? '').trim().length > 0) return walk.currentNode;
      }
      return null;
    })();

    return {
      badge: { w: +b.width.toFixed(3), h: +b.height.toFixed(3) },
      glyph: { w: +g.width.toFixed(3), h: +g.height.toFixed(3) },
      // Insets of the glyph box within the badge box, all four sides.
      inset: {
        left: +(g.left - b.left).toFixed(3),
        top: +(g.top - b.top).toFixed(3),
        right: +(b.right - g.right).toFixed(3),
        bottom: +(b.bottom - g.bottom).toFixed(3),
      },
      padding: bCS.padding,
      margin: bCS.margin,
      borderWidth: bCS.borderTopWidth,
      ink: { w: +ink.width.toFixed(3), h: +ink.height.toFixed(3) },
      radius: bCS.borderRadius,
      fill: bCS.backgroundColor,
      glyphColour: getComputedStyle(path).fill,
      // Gap to the label: the distance from the badge's right edge to the label
      // TEXT's left edge, not read off the `gap` property and not taken from the
      // anchor's right edge (that would include the label's own width — it
      // measured 71px, i.e. 8 + the 63px label, and read like a broken gap).
      // The label is a bare text node with no element of its own, so it needs a
      // Range to have a box at all. In a flex container it is an anonymous flex
      // item and its surrounding whitespace is stripped, so the rect starts at
      // the "M".
      gapToLabel: (() => {
        if (!labelNode) return null;  // null, never 0 — "could not measure" is not "no gap"
        const r = document.createRange();
        r.selectNodeContents(labelNode);
        return +(r.getBoundingClientRect().left - b.right).toFixed(3);
      })(),
      cssGap: getComputedStyle(brand).columnGap,
      // Read from the element the label text actually inherits from, resolved at
      // runtime, rather than from the anchor on the assumption that they are the
      // same element. Now genuinely so: the search above is deep, so a wrapper
      // becomes the host and its own font-size is what gets measured.
      // They are the same element today — the label is a bare text node whose
      // parent IS the anchor — but wrapping it in a <span> with its own
      // font-size would leave an anchor-based assertion green while the rendered
      // label changed. `labelParentIsAnchor` records which case was measured, so
      // the assumption fails loudly instead of silently.
      ...(() => {
        const host = (labelNode?.parentElement ?? brand) as HTMLElement;
        const cs = getComputedStyle(host);
        return {
          labelFound: !!labelNode,
          labelParentIsAnchor: host === brand,
          labelFontSize: cs.fontSize,
          labelFontWeight: cs.fontWeight,
          // The DECLARED stack, not the face that renders. getComputedStyle
          // returns the list verbatim, so this reads identically on a machine
          // whose `system-ui` is a monospace font and on CI's, which is what
          // makes it assertable at all — see the label test.
          labelFontFamily: cs.fontFamily,
        };
      })(),
      badgeInsideAnchor: brand.contains(badge) && brand.tagName === 'A',
      badgeIsFirst: brand.firstElementChild === badge,
      ariaHidden: badge.getAttribute('aria-hidden') === 'true'
        || svg.getAttribute('aria-hidden') === 'true',
    };
  });

  // ---------------------------------------------------------------------------
  // Geometry — measured, both themes, both root font sizes
  // ---------------------------------------------------------------------------

  for (const root of [16, 24]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`badge and glyph render at contract size — ${theme}, ${root}px root`, async ({ page }) => {
        if (theme === 'dark') await darkMode(page);
        if (root !== 16) {
          await page.evaluate(r => { document.documentElement.style.fontSize = `${r}px`; }, root);
        }
        const m = await geometry(page);

        expect(m.badge.w).toBeCloseTo(28, 1);
        expect(m.badge.h).toBeCloseTo(28, 1);
        expect(m.radius).toBe('6px');
        expect(m.glyph.w).toBeCloseTo(17, 1);
        expect(m.glyph.h).toBeCloseTo(17, 1);

        // The badge is sized in px and the label in rem, so the assertions above
        // also record that the badge does NOT grow with the reader's font. Both
        // sibling apps ship it that way; the rem question is an open design item
        // upstream, not a local choice to change.
        //
        // A missing text node returns null rather than 0, so "could not measure"
        // fails here instead of passing as a zero gap.
        expect(m.gapToLabel, 'label text node not found').not.toBeNull();
        expect(m.gapToLabel!).toBeCloseTo(8, 1);

        // Centring: equal (28 − 17) / 2 = 5.5px insets on all four sides. The
        // box sizes alone do NOT imply this — with the global
        // `* { box-sizing: border-box }`, a `padding-left` on .brand-logo keeps
        // the badge 28x28 and the glyph 17x17 while sliding the mark off centre,
        // and every other assertion here stays green.
        expect(m.inset.left, 'left inset').toBeCloseTo(5.5, 1);
        expect(m.inset.top, 'top inset').toBeCloseTo(5.5, 1);
        expect(m.inset.right, 'right inset').toBeCloseTo(5.5, 1);
        expect(m.inset.bottom, 'bottom inset').toBeCloseTo(5.5, 1);

        // The contract also specifies these are zero; centring is achieved by
        // flex alignment, not by padding that happens to be symmetric.
        expect(m.padding).toBe('0px');
        expect(m.margin).toBe('0px');
        expect(m.borderWidth).toBe('0px');
      });
    }
  }

  // The mark's ink must span at least 85% of the glyph box on its larger axis.
  // This is the assertion that catches the failure nothing else can: MyNotes'
  // favicon glyph fills only 9.9 x 11 of its 32-unit viewBox, so dropping it in
  // uncropped renders it at ~31% while leaving the badge box and the glyph box
  // both perfectly correct. Logo.tsx crops the viewBox to `10 10 12 12` for
  // exactly this reason — see the comment there.
  for (const theme of ['light', 'dark'] as const) {
    test(`mark ink spans at least 85% of the glyph box — ${theme}`, async ({ page }) => {
      if (theme === 'dark') await darkMode(page);
      const m = await geometry(page);
      const larger = Math.max(m.ink.w, m.ink.h);
      const box = Math.max(m.glyph.w, m.glyph.h);
      const extent = larger / box;
      expect(extent, `ink ${larger}px in a ${box}px glyph box`).toBeGreaterThanOrEqual(0.85);
    });
  }

  // ---------------------------------------------------------------------------
  // Placement — distance from the viewport's top and left edges
  // ---------------------------------------------------------------------------

  // (16, 14) is the shared position: MyMail measures there, and MyCal's
  // `min-height: 40px` was chosen so its badge would land on the same number
  // (its app.css says so). MyNotes was the outlier at (12, 17.30) until the
  // sidebar inset went to 16px and `.sidebar-brand` was top-aligned.
  //
  // Both coordinates are now single declarations rather than remainders:
  // x is `.sidebar-header`'s 16px margin, y is `.sidebar`'s 14px padding-top.
  // That is the property worth protecting — the old y was a leftover of
  // `.sidebar-tab`'s typography, so a tab's font-size moved the badge.
  for (const root of [16, 20, 24, 32]) {
    test(`the badge sits 16px from the left and 14px from the top — ${root}px root`, async ({ page }) => {
      if (root !== 16) {
        await page.evaluate(r => { document.documentElement.style.fontSize = `${r}px`; }, root);
      }
      const box = await page.locator(BADGE).boundingBox();
      expect(box, 'badge has no box').not.toBeNull();
      expect(box!.x, 'distance from the left viewport edge').toBeCloseTo(16, 1);
      expect(box!.y, 'distance from the top viewport edge').toBeCloseTo(14, 1);

      // Not scrolled — "at rest" is part of the claim, and a scrolled page would
      // give a y that means something else entirely.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });
  }

  // **This is what makes the position *authored* rather than merely correct.**
  // Both offsets used to be remainders: y was `(header height − brand height)/2`,
  // a function of `.sidebar-tab`'s typography, and after that fix it was still
  // `(brand height − 28)/2` — zero only while the 28px badge out-measured the
  // label's line box, i.e. only up to a ~18.67px root.
  //
  // A remainder that happens to be zero and a number that is declared are the
  // same reading and different conformance. This test tells them apart: it grows
  // the LABEL's line-height, which neither `.sidebar` nor `.sidebar-header`
  // mentions, and requires the badge not to move. `.brand-logo`'s
  // `align-self: flex-start` is what makes that true.
  for (const lh of ['2.2', '4']) {
    test(`the badge does not move when the label's line-height grows to ${lh}`, async ({ page }) => {
      const before = (await page.locator(BADGE).boundingBox())!;
      const brandBefore = (await page.locator(BRAND).boundingBox())!;

      await page.evaluate(v => {
        (document.querySelector('.sidebar-brand') as HTMLElement).style.lineHeight = v;
      }, lh);

      const brandAfter = (await page.locator(BRAND).boundingBox())!;
      // Prove the mutation actually took: if the brand did not grow, the badge
      // holding still proves nothing at all.
      expect(brandAfter.height, 'label line-height did not change the brand — vacuous test')
        .toBeGreaterThan(brandBefore.height + 1);

      const after = (await page.locator(BADGE).boundingBox())!;
      expect(after.y, 'badge y moved with the label — it is still a remainder').toBeCloseTo(before.y, 1);
      expect(after.y).toBeCloseTo(14, 1);
    });
  }

  // The reason the whole 16px inset moved rather than just the header: the badge
  // has to line up with the note list beneath it, or fixing the cross-app
  // misalignment would introduce a within-app one. MyMail's header and folder
  // list share their inset too.
  test('the badge lines up with the note list below it', async ({ page, request }) => {
    const made = await request.post('/api/v1/notes', {
      data: { title: 'Alignment probe note', content: 'body\n' },
    });
    expect(made.ok(), `seeding: ${made.status()}`).toBe(true);
    await page.reload();

    const link = page.locator('.notes-list-scroll .note-row .link').first();
    await expect(link, 'no note row rendered — nothing was compared').toBeVisible();

    const badge = (await page.locator(BADGE).boundingBox())!;
    const text = (await link.boundingBox())!;
    expect(text.x, 'note text must share the badge left edge').toBeCloseTo(badge.x, 1);

    await request.delete(`/api/v1/notes/${(await made.json()).slug}`);
  });

  // ---------------------------------------------------------------------------
  // Colour
  // ---------------------------------------------------------------------------

  test('badge fill and glyph colour follow the theme', async ({ page }) => {
    const light = await geometry(page);
    expect(light.fill).toBe('rgb(37, 99, 235)');        // --primary, light
    expect(light.glyphColour).toBe('rgb(255, 255, 255)'); // via currentColor

    await darkMode(page);
    const dark = await geometry(page);
    expect(dark.fill).toBe('rgb(59, 130, 246)');         // --primary, dark
    expect(dark.glyphColour).toBe('rgb(255, 255, 255)');

    // Prove the theme switch actually moved the fill, rather than both reads
    // landing on the same value and the pair passing vacuously.
    expect(dark.fill).not.toBe(light.fill);
  });

  // ---------------------------------------------------------------------------
  // Structure and accessibility
  // ---------------------------------------------------------------------------

  // The app-name label IS a cross-repo contract as of ../mysuite,
  // spec/app-name-label.md — the same declared font stack, the same 1.1rem and
  // the same placement in all three apps. This is MyNotes' half of
  // app-name-label.md §7.2; like the rest of this file it can only see this app
  // and never establishes that the three still agree.
  //
  // It was NOT a contract value when this test was written: app-logo.md §2 put
  // the label out of scope while this corner was crowded, and that ruling was
  // conditional on the crowding. Widening the column spent the condition and
  // the owner reopened it — app-name-label.md §2.1 records the supersession.
  //
  // TWO roots, and neither replaces the other:
  //
  //   * 16px is the load-bearing case and must stay. The label's own vertical
  //     position is a remainder, and it is nonzero ONLY at the default root:
  //     measured here, the label's flex-item box sits 0.796875px below the
  //     badge's top at a 16px root and exactly 0 at 17, 18, 20, 24 and 32,
  //     because the 28px badge stops out-measuring the label's 1.65 × root line
  //     box just under 17px (app-name-label.md §4.1). A sweep that omitted 16
  //     would be measuring the one case where the defect is absent.
  //
  //   * 32px is what makes the *unit* observable. 17.6px is 1.1rem at a 16px
  //     root, so a `1.1rem` → `17.6px` normalisation passes a 16px-only
  //     assertion while freezing the label at every other root — the edit is
  //     invisible at exactly the root a single-root test uses.
  //
  // KNOWN LIMIT: `1.1rem` → `1.1em` renders identically at EVERY root, since
  // the anchor's parent inherits 1rem. No rendered assertion can see it, here
  // or in either sibling. `mysuite/tools/check-contract.py` does — it compares
  // this declaration's text across the three repos and pins it STRONG
  // (app-name-label.md §7.1); mutating this app to `1.1em` makes it report
  // "found `font-size: 1.1em`, expected `1.1rem`". Nobody's CI runs it, so the
  // gap is real but it is a "somebody must run it" gap, not an absence.
  // The stack is asserted, not the face that renders it. `system-ui` resolves
  // per machine — on this one it is a MONOSPACE font — and no API reports the
  // resolved face portably, so the rendered face is unguardable and
  // app-name-label.md §7.3 says so. getComputedStyle returns the declared list
  // verbatim, which is what §3.1 mandates and what reads the same everywhere.
  const LABEL_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  // Pairs, not `root * 1.1`: 16 * 1.1 serialises as 17.600000000000001 in IEEE
  // 754 (32 * 1.1 happens to be exact), so computing the expectation would fail
  // on the default root for a reason that has nothing to do with the app. Pairs
  // also stop a third root silently inheriting 32's number.
  for (const [root, expected] of [[16, '17.6px'], [32, '35.2px']] as const) {
    test(`the app-name label matches the siblings — ${root}px root`, async ({ page }) => {
      if (root !== 16) {
        await page.evaluate(r => { document.documentElement.style.fontSize = `${r}px`; }, root);
      }
      const m = await geometry(page);
      // A missing text node would fall back to the anchor and quietly measure
      // something else, so establish what was measured before believing it.
      expect(m.labelFound, 'no label text node — nothing was measured').toBe(true);
      // And establish that the anchor IS still what the label inherits from.
      // Wrapping the text in a <span> is geometrically free (measured: Δ = 0 on
      // all four axes), so without this every assertion below stays green while
      // measuring a different element. Not a demand for an element — §8.4
      // declines to require one; this asserts that there is not one yet.
      expect(m.labelParentIsAnchor,
        'label is wrapped — assertions keyed to the anchor no longer measure it')
        .toBe(true);
      expect(m.labelFontFamily).toBe(LABEL_STACK);   // §3.1
      expect(m.labelFontSize).toBe(expected);        // §3.2
      // NOT a contract value — app-name-label.md §5 records `font-weight` and
      // deliberately does not mandate it. Kept because the three do agree on it
      // and a silent drift is worth knowing about, but a red here is a MyNotes
      // question, not a three-repo one.
      expect(m.labelFontWeight).toBe('600');
    });
  }

  test('badge sits inside the brand anchor, ahead of the label, and is decorative', async ({ page }) => {
    const m = await geometry(page);
    expect(m.badgeInsideAnchor, 'badge must be inside <a class="brand sidebar-brand">').toBe(true);
    expect(m.badgeIsFirst, 'badge must precede the label in reading order').toBe(true);
    expect(m.ariaHidden, 'badge must be aria-hidden').toBe(true);

    // The mark is decorative, so the link's accessible name must still be the
    // label text alone — this is what makes the aria-hidden load-bearing.
    await expect(page.getByRole('link', { name: 'MyNotes', exact: true })).toBeVisible();
  });

  // MyNotes-ONLY. The badge is a descendant of an <a>, which is true in neither
  // sibling app, so no other repo's suite can catch a link style bleeding onto
  // the mark. A `.brand:hover { color: var(--link) }` — an entirely ordinary
  // rule to add — would repaint the glyph through `currentColor`.
  for (const theme of ['light', 'dark'] as const) {
    test(`the brand link paints nothing onto the badge — ${theme}`, async ({ page }) => {
      if (theme === 'dark') await darkMode(page);

      // Park the pointer away first: a previous move could leave the brand
      // hovered, making both reads the same measurement and the comparison
      // vacuous. Asserted rather than assumed, in both directions.
      await page.mouse.move(1200, 600);
      expect(await page.locator(BRAND).evaluate(el => el.matches(':hover'))).toBe(false);
      const cold = await geometry(page);

      await page.locator(BRAND).hover();
      expect(
        await page.locator(BRAND).evaluate(el => el.matches(':hover')),
        'hover did not take — the comparison below would prove nothing',
      ).toBe(true);
      const hot = await geometry(page);

      expect(hot.fill, 'hover changed the badge fill').toBe(cold.fill);
      expect(hot.glyphColour, 'hover changed the glyph colour').toBe(cold.glyphColour);
      expect(
        await page.locator(BADGE).evaluate(el => getComputedStyle(el).textDecorationLine),
      ).toBe('none');
    });
  }

  // ---------------------------------------------------------------------------
  // The header still fits — at a 16px root ONLY, deliberately
  // ---------------------------------------------------------------------------

  // `.sidebar-tabs` is `flex: 1; min-width: 0` with no `overflow`, so when the
  // header runs out of room the strip shrinks BELOW its content and the tabs
  // paint underneath the action buttons. Nothing moves, nothing clips, nothing
  // errors. The obvious check — the buttons' right edge against the header's —
  // returns clean zero in every visibly broken case, at every root size. These
  // are the two assertions that can actually see it.
  //
  // **Not asserted at 20px or 24px, and that is deliberate** — still, but for a
  // changed reason, so the old note is not merely repeated here. The pre-existing
  // WCAG 1.4.4 Resize Text defect predates this work and was not bought here.
  // Widening the column to 540px (see .sidebar in app.css) moved the numbers
  // without settling the question: measured on this machine, a 20px root needs
  // 535px and so now fits — by 5px, a 1.02× margin — while a 24px root needs
  // 612px and still overflows.
  //
  // A 1.02× margin is exactly the state this suite has just been through: it
  // fits the font in front of you and not CI's, which is ~1.25× wider. So
  // asserting the fit at 20px would pin a threshold rather than a margin, and
  // buy back the failure mode. Extend this loop only when a 20px root has real
  // headroom — the test below is where that is measured.
  test('the header row still fits at a 16px root, with the badge', async ({ page }) => {
    const fit = await page.evaluate(() => {
      const tabs = document.querySelector('.sidebar-tabs') as HTMLElement;
      const actions = document.querySelector('.sidebar-actions') as HTMLElement;
      const tabEls = Array.from(tabs.querySelectorAll('.sidebar-tab')) as HTMLElement[];
      const last = tabEls[tabEls.length - 1];
      return {
        tabCount: tabEls.length,
        stripOverflowing: tabs.scrollWidth > tabs.clientWidth,
        clearanceToButtons: +(actions.getBoundingClientRect().left
          - last.getBoundingClientRect().right).toFixed(3),
      };
    });

    // A strip with no tabs would report no overflow and pass while measuring
    // nothing — "absent" must not be mistaken for "fits".
    expect(fit.tabCount, 'no tabs found — nothing was measured').toBe(3);
    expect(fit.stripOverflowing, 'the tab strip is overflowing its box').toBe(false);
    expect(fit.clearanceToButtons, 'the last tab is overlapping the action buttons')
      .toBeGreaterThan(0);
  });

  // The test above says the row fits **on the machine running it**, and that is
  // the whole reason this one exists: it passed locally for weeks with ~6px of
  // slack and went red in CI, where `system-ui` resolves ~1.25× wider. A binary
  // fits/does-not-fit assertion cannot tell a comfortable row from one a single
  // font substitution away from breaking, and the breakage is invisible (see the
  // comment above) — so what is asserted here is the *margin*: the px of room the
  // row has left over.
  //
  // **In px, and not as "absorbs N× wider text", which is the trap.** That ratio
  // is (available − fixed) / text, and `text` is whatever the machine running the
  // test renders. Its numerator is font-independent, so a wider font shrinks the
  // ratio without the row being any worse off: this column reads 1.41× here and
  // about 1.13× on CI's ~25%-wider system-ui, on 30-odd px of perfectly good
  // slack. A fixed floor under a machine-relative ratio would fail exactly where
  // the fonts are widest — reproducing, in the guard, the bug the guard is for.
  //
  // So the weight is put on the half of the row that no font can move — the px
  // of space available *for* text — and only a low backstop on the half that
  // varies. See the two assertions at the bottom, which say which is which.
  //
  // Deriving the fixed part by subtraction rather than listing it (badge, tab
  // padding, buttons, gaps) keeps this from going stale every time one of those
  // changes: whatever they are, the row's own numbers still decompose into "text"
  // and "not text".
  test('the header keeps room to spare at a 16px root', async ({ page }) => {
    const m = await page.evaluate(() => {
      const px = (el: Element, prop: string) => parseFloat(getComputedStyle(el).getPropertyValue(prop)) || 0;
      const textWidth = (node: ChildNode | null | undefined) => {
        if (!node) return 0;
        const r = document.createRange();
        r.selectNodeContents(node);
        return r.getBoundingClientRect().width;
      };

      const header = document.querySelector('.sidebar-header') as HTMLElement;
      const brand = document.querySelector('.sidebar-brand') as HTMLElement;
      const tabs = document.querySelector('.sidebar-tabs') as HTMLElement;
      const actions = document.querySelector('.sidebar-actions') as HTMLElement;
      const tabEls = Array.from(tabs.querySelectorAll('.sidebar-tab')) as HTMLElement[];

      // The label is a bare text node beside the badge, so it has no box of its
      // own to measure — a Range is the only way to get its width.
      const label = Array.from(brand.childNodes)
        .find(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      const labelText = textWidth(label);
      const tabTexts = tabEls.map(t => textWidth(t.firstChild));
      const textTotal = labelText + tabTexts.reduce((s, w) => s + w, 0);

      const tabsContent = tabEls.reduce((s, t) => s + t.getBoundingClientRect().width, 0)
        + px(tabs, 'column-gap') * (tabEls.length - 1);
      const rowContent = brand.getBoundingClientRect().width
        + tabsContent
        + actions.getBoundingClientRect().width
        + px(header, 'column-gap') * 2;

      return {
        labelText,
        tabTexts,
        tabCount: tabEls.length,
        textTotal,
        available: header.clientWidth,
        fixed: rowContent - textTotal,
        // `.sidebar-tab` is `0 1 auto`, so in an already-overflowing row the tabs
        // are compressed below their content and both totals above would be read
        // from a squeezed row — a smaller `fixed` making the slack look better
        // than it is. The numbers mean what they say only while the row fits.
        stripFits: tabs.scrollWidth <= tabs.clientWidth,
      };
    });

    // Guards on the measurement itself: a Range over a missing node returns 0,
    // which would make the slack below look larger and the test vacuous.
    expect(m.labelText, 'no brand label measured').toBeGreaterThan(0);
    expect(m.tabTexts.filter(w => w > 0).length, 'not every tab label was measured')
      .toBe(m.tabCount);
    expect(m.stripFits, 'the row is already overflowing — the totals below are compressed')
      .toBe(true);

    // Two assertions, because the row has two kinds of margin and only the first
    // is a property of the design rather than of the machine.
    //
    // 1. Room for text. Both terms are px/rem geometry — column, border, insets,
    //    badge, tab padding, gaps, icon buttons — so this reads the SAME on every
    //    machine no matter what system-ui resolves to, and can carry a real
    //    threshold without punishing wide fonts. 257px today; the floor is
    //    1.35 × the 182px of text this repo's authoring machine renders at a 16px
    //    root, which is the reference the column was sized against (see .sidebar
    //    in app.css). A narrower column, a fourth tab or a wider button trips it.
    const room = m.available - m.fixed;
    expect(room,
      `the header has room for only ${room.toFixed(1)}px of text `
      + `(${m.available}px available − ${m.fixed.toFixed(1)}px of fixed parts)`)
      .toBeGreaterThan(246);

    // 2. What is actually left over here and now. This one IS machine-dependent —
    //    a wider font eats it legitimately (~33px on CI's, against 75px here) — so
    //    the floor is deliberately near the bottom: it catches a row that has all
    //    but closed on the machine in front of you, and leaves the guarding to the
    //    assertion above. Do not raise it to something that looks respectable;
    //    that is precisely how this suite went red on a row that fit.
    const slack = m.available - m.fixed - m.textTotal;
    const factor = room / m.textTotal;
    expect(slack,
      `only ${slack.toFixed(1)}px of room left in the header row — `
      + `${m.textTotal.toFixed(1)}px of text, ${m.fixed.toFixed(1)}px fixed, `
      + `${m.available}px available (absorbs ${factor.toFixed(2)}× this machine's text)`)
      .toBeGreaterThan(8);
  });
});
