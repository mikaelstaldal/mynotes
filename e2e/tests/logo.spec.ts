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
        const textNode = Array.from(brand.childNodes).find(
          n => n.nodeType === Node.TEXT_NODE && n.textContent!.trim().length > 0,
        );
        if (!textNode) return null;   // null, never 0 — "could not measure" is not "no gap"
        const r = document.createRange();
        r.selectNodeContents(textNode);
        return +(r.getBoundingClientRect().left - b.right).toFixed(3);
      })(),
      cssGap: getComputedStyle(brand).columnGap,
      // Read from the element the label text actually inherits from, resolved at
      // runtime, rather than from the anchor on the assumption that they are the
      // same element. They are today — the label is a bare text node whose
      // parent IS the anchor — but wrapping it in a <span> with its own
      // font-size would leave an anchor-based assertion green while the rendered
      // label changed. `labelParentIsAnchor` records which case was measured, so
      // the assumption fails loudly instead of silently.
      ...(() => {
        const textNode = Array.from(brand.childNodes).find(
          n => n.nodeType === Node.TEXT_NODE && n.textContent!.trim().length > 0,
        );
        const host = (textNode?.parentElement ?? brand) as HTMLElement;
        const cs = getComputedStyle(host);
        return {
          labelFound: !!textNode,
          labelParentIsAnchor: host === brand,
          labelFontSize: cs.fontSize,
          labelFontWeight: cs.fontWeight,
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
  test('the badge sits 16px from the left and 14px from the top', async ({ page }) => {
    const box = await page.locator(BADGE).boundingBox();
    expect(box, 'badge has no box').not.toBeNull();
    expect(box!.x, 'distance from the left viewport edge').toBeCloseTo(16, 1);
    expect(box!.y, 'distance from the top viewport edge').toBeCloseTo(14, 1);

    // Not scrolled — "at rest" is part of the claim, and a scrolled page would
    // give a y that means something else entirely.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

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

  // The app-name label is deliberately NOT part of the logo contract — MyNotes'
  // is smaller than MyCal's and MyMail's and the human ruled that it stays that
  // way, because this corner is crowded. Adding the badge required giving the
  // anchor its own flex context, which touches the label's rule; this asserts
  // that it did not touch the label's *typography*, which is the part under the
  // ruling. It is a local guard, not a contract assertion — if the ruling
  // changes, this changes with it and nothing upstream cares.
  test('the app-name label keeps the size the ruling fixed it at', async ({ page }) => {
    const m = await geometry(page);
    // A missing text node would fall back to the anchor and quietly measure
    // something else, so establish what was measured before believing it.
    expect(m.labelFound, 'no label text node — nothing was measured').toBe(true);
    expect(m.labelFontSize).toBe('16px');
    expect(m.labelFontWeight).toBe('600');
  });

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
  // **Not asserted at 20px or 24px, and that is deliberate.** The header already
  // overflows at those roots WITHOUT the badge — a pre-existing WCAG 1.4.4
  // Resize Text defect that predates this work and was explicitly not bought
  // here, because fixing it by widening would cost the main pane at every root
  // size. Asserting it would make this suite red for a defect it is not about.
  // If that defect is fixed, extend this loop to [16, 20, 24] and it should pass.
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
});
