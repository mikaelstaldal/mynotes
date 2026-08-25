import { test, expect, type APIRequestContext } from '@playwright/test';

// A plain click anywhere on the read view opens the editor. The rule is only
// half the feature, though: the read view is also where the reader follows a
// link, filters by a tag, folds a callout, ticks a task box, selects a passage
// to copy and reaches the action toolbar, and every one of those is a click on
// the read view too. So the exceptions are tested at the same weight as the rule
// — an implementation that opened the editor on *every* click would pass the
// first three tests here and break the app.
//
// Like `note-list-refetch.spec.ts` and `tag-filter-persistence.spec.ts`, and
// unlike `sidebar-footer.spec.ts` / `logo.spec.ts`, this spec is MyNotes-local:
// it implements no cross-repo contract and asserts no coordinate, colour or
// computed value.
test.describe('Click to edit', () => {
  const NOTES_API = '/api/v1/notes';
  const TAGS_API = '/api/v1/tags';
  const SLUG = 'click-to-edit-subject';
  const TARGET = 'click-to-edit-target';
  const TAG = 'clicktag';

  // One note carrying every interactive thing the read view can render: a plain
  // paragraph (the click that must edit), a wikilink, a task item, and a
  // foldable callout. `[!note]-` is the Obsidian fold marker — it renders the
  // callout as <details> with a <summary> title, which is the element the
  // exception list names.
  const CONTENT = [
    'The body paragraph, long enough to select a run of words from.',
    '',
    '- [ ] a task item',
    '',
    '> [!note]-',
    '> The folded body.',
    '',
    'A link to [[' + TARGET + ']].',
  ].join('\n');

  const resetNotes = async (request: APIRequestContext) => {
    // Paged, like the other specs' copies: `limit` is capped at 200 by
    // openapi.yaml, so a single pass silently under-deletes past that.
    for (let pass = 0; pass < 20; pass++) {
      const { notes } = await (await request.get(NOTES_API, { params: { limit: 200 } })).json();
      if (notes.length === 0) break;
      for (const note of notes) {
        const gone = await request.delete(`${NOTES_API}/${note.slug}`);
        expect(gone.ok(), `deleting ${note.slug}: ${gone.status()}`).toBe(true);
      }
    }
  };

  test.beforeEach(async ({ request }) => {
    await resetNotes(request);
    // POST /notes rejects an unknown tag slug with a 400 — only the Markdown
    // import path auto-creates tags — so the tag has to exist first. 409 means a
    // previous run already made it.
    const tag = await request.post(TAGS_API, { data: { slug: TAG } });
    expect([201, 409], `creating tag ${TAG}: ${tag.status()}`).toContain(tag.status());

    // The wikilink's destination, so following it lands on a read view rather
    // than the create-on-404 editor, which would look like a pass.
    const target = await request.post(NOTES_API, {
      data: { title: 'Click to edit target', content: 'The other note.', slug: TARGET },
    });
    expect(target.ok(), `creating ${TARGET}: ${target.status()}`).toBe(true);

    const note = await request.post(NOTES_API, {
      data: { title: 'Click to edit subject', content: CONTENT, slug: SLUG, tags: [TAG] },
    });
    expect(note.ok(), `creating ${SLUG}: ${note.status()}`).toBe(true);
  });

  const openNote = async (page: import('@playwright/test').Page) => {
    await page.goto(`/notes/${SLUG}`);
    await expect(page.locator('main .note-content')).toBeVisible();
  };

  test('clicking the note body opens the editor', async ({ page }) => {
    await openNote(page);
    await page.locator('main .note-content p').first().click();
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}/edit$`));
    await expect(page.locator('.cm-editor')).toBeVisible();
  });

  test('clicking the empty space below the note opens the editor', async ({ page }) => {
    await openNote(page);
    // The scroll region is `flex: 1`, so with a short note most of it is empty
    // and a click near its bottom edge lands on the region itself rather than on
    // any rendered element. That empty space is part of the read view and is the
    // easiest place for a reader to aim at.
    const scroll = page.locator('.note-view-scroll');
    const box = await scroll.boundingBox();
    expect(box, 'the scroll region has no box').not.toBeNull();
    await scroll.click({ position: { x: box!.width / 2, y: box!.height - 5 } });
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}/edit$`));
  });

  test('clicking the title or the timestamps opens the editor', async ({ page }) => {
    await openNote(page);
    await page.locator('.note-title').click();
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}/edit$`));

    await openNote(page);
    await page.locator('.note-view-date').click();
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}/edit$`));
  });

  test('a link in the note still follows the link', async ({ page }) => {
    await openNote(page);
    await page.locator(`main .note-content a[href$="/notes/${TARGET}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/notes/${TARGET}$`));
    await expect(page.locator('main .note-content')).toContainText('The other note.');
  });

  test('a tag chip still filters the sidebar', async ({ page }) => {
    await openNote(page);
    await page.locator(`.note-header-left .tag-chip[href$="/tags/${TAG}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/tags/${TAG}$`));
  });

  test('a foldable callout still folds instead of editing', async ({ page }) => {
    await openNote(page);
    const details = page.locator('main .note-content details.callout-foldable');
    await expect(details).toHaveJSProperty('open', false);

    await details.locator('summary').click();
    await expect(details).toHaveJSProperty('open', true);
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}$`));
  });

  test('a task checkbox still opens the editor with that item toggled', async ({ page }) => {
    await openNote(page);
    await page.locator('main .note-content input.task-list-item-checkbox').click();
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}/edit$`));
    // The distinguishing part: click-to-edit alone would open the editor on the
    // note as it is stored, with the box still empty.
    await expect(page.locator('.preview-pane .note-content input.task-list-item-checkbox'))
      .toBeChecked();
  });

  test('the action toolbar is not click-to-edit', async ({ page }) => {
    await openNote(page);
    // Split, because it opens a dialog that is a DOM child of the note header —
    // so it exercises both halves at once: the button is not click-to-edit, and
    // neither is a click inside the dialog it opens.
    await page.locator('main').getByRole('button', { name: 'Split by headings' }).click();
    await expect(page.locator('.split-dialog')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}$`));

    await page.locator('.split-title').click();
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}$`));
    await page.locator('.split-dialog button', { hasText: 'Cancel' }).click();
    await expect(page.locator('.split-dialog')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}$`));
  });

  test('drag-selecting a passage selects rather than edits', async ({ page }) => {
    await openNote(page);
    const paragraph = page.locator('main .note-content p').first();
    const box = await paragraph.boundingBox();
    expect(box, 'the paragraph has no box').not.toBeNull();

    // A real drag-select: mousedown and mouseup inside the same paragraph, which
    // still fires a click on it — that click is the one the selection guard has
    // to swallow. Without the guard, selecting text to copy would throw the
    // reader into the editor and drop the selection on the way.
    await page.mouse.move(box!.x + 5, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height / 2, { steps: 10 });
    await page.mouse.up();

    expect(await page.evaluate(() => window.getSelection()?.toString() ?? ''),
      'nothing was selected, so the guard was never exercised').not.toBe('');
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}$`));
  });

  // This test records an accepted cost, not a desirable property — the only one
  // here that does. `click` fires after the first release of a double-click,
  // while the browser selects the word on the second press, so the editor is
  // already open by then and word-select is unreachable in the read view;
  // triple-click loses paragraph-select the same way. Preserving either would
  // mean deferring every open by the multi-click window (~350 ms), and that was
  // weighed against opening the editor instantly and lost.
  //
  // It is pinned so that re-deciding it is deliberate: an implementation that
  // deferred the open to rescue word-select would turn this red rather than
  // slipping the delay in unnoticed. Drag-select (above) and Ctrl+A are what
  // remain, and both still work.
  test('double-click opens the editor rather than selecting a word (accepted cost)', async ({ page }) => {
    await openNote(page);
    await page.locator('main .note-content p').first().dblclick();
    await expect(page).toHaveURL(new RegExp(`/notes/${SLUG}/edit$`));
  });

  test('a modified click is left to the browser', async ({ page }) => {
    await openNote(page);
    // Meta is in the table because the implementation guards it separately and
    // it is the primary modifier on macOS; Chromium synthesizes it on Linux, so
    // leaving it out would let a regression that deleted only that guard through.
    for (const modifiers of [['Control'], ['Meta'], ['Shift'], ['Alt']] as const) {
      await page.locator('main .note-content p').first().click({ modifiers: [...modifiers] });
      await expect(page, `${modifiers[0]}-click opened the editor`)
        .toHaveURL(new RegExp(`/notes/${SLUG}$`));
    }
  });
});
