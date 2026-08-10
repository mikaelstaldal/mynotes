import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// Opening a note from a tag-filtered sidebar list must leave the sidebar
// filtered. It did not: the list read its tag filter straight off the route, and
// `/notes/<slug>` names no tags, so the filter emptied the moment the reader
// clicked a row — the list they were reading through was replaced by every note
// in the database, under the pointer.
//
// The filter now lives in app.tsx and is written only by the list routes, so the
// "still follows the list routes" tests here are as load-bearing as the
// persistence ones: they are two halves of one rule, and an implementation that
// simply stopped clearing would pass the first half alone.
//
// Like `note-list-refetch.spec.ts` and unlike the other two specs in this
// directory, this one is MyNotes-local: it implements no cross-repo contract,
// and it asserts no coordinate, colour or computed value.
test.describe('Sidebar tag filter persistence', () => {
  const NOTES_API = '/api/v1/notes';
  const TAGS_API = '/api/v1/tags';
  const TAG = 'kept';
  const OTHER = 'other';
  const TAGGED = 3;
  const UNTAGGED = 2;

  // The sidebar's own rows and its own filter chips. Both selectors are scoped
  // on purpose: the main-panel overview renders `.note-row` too (under
  // `.overview-scroll`), and every note row renders a `.tag-chip` per tag it
  // carries, so an unscoped count would be measuring the wrong thing in both
  // cases and would still look plausible.
  const SIDEBAR_ROWS = '.notes-list-scroll .note-row';
  const FILTER_CHIPS = '.notes-list-controls .tag-chip';
  // A list request, as opposed to the single-note GET the note view issues: only
  // the list carries a query string. Same distinction as note-list-refetch.spec.ts.
  const LIST_QUERY = `${NOTES_API}?`;
  // Long enough that a list request provoked by the navigation under test has
  // either been issued or is not coming.
  const SETTLE = 600;

  const resetNotes = async (request: APIRequestContext) => {
    // Paged, like note-list-refetch.spec.ts's copy: `limit` is capped at 200 by
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

  // Record every sidebar-list request from here on. Asserting the list did *not*
  // refetch is what makes the "still filtered" assertions below deterministic:
  // in the reverted implementation the sidebar reverts only once a refetch
  // lands, so a retrying count matcher could otherwise poll before it does and
  // go green on broken code.
  const watchListRequests = (page: Page): string[] => {
    const seen: string[] = [];
    page.on('request', r => { if (r.url().includes(LIST_QUERY)) seen.push(r.url()); });
    return seen;
  };

  test.beforeEach(async ({ request }) => {
    await resetNotes(request);
    // Required, not belt-and-braces: only the Markdown-import path auto-creates
    // missing tags (`NoteService.ensureTags`); POST /notes rejects an unknown
    // tag slug with a 400. 409 means a previous run already created it.
    for (const slug of [TAG, OTHER]) {
      const made = await request.post(TAGS_API, { data: { slug } });
      expect([201, 409], `creating tag ${slug}: ${made.status()}`).toContain(made.status());
    }

    for (let i = 0; i < TAGGED; i++) {
      // The first tagged note carries both tags, so a row in the `kept` list
      // offers a link to a *different* filter — see the replacement test.
      const note = await request.post(NOTES_API, {
        data: {
          title: `Tagged note ${i}`,
          content: `Body ${i}.`,
          tags: i === 0 ? [TAG, OTHER] : [TAG],
        },
      });
      expect(note.ok(), `creating tagged note ${i}: ${note.status()}`).toBe(true);
    }
    for (let i = 0; i < UNTAGGED; i++) {
      const note = await request.post(NOTES_API, {
        data: { title: `Untagged note ${i}`, content: `Body ${i}.` },
      });
      expect(note.ok(), `creating untagged note ${i}: ${note.status()}`).toBe(true);
    }
  });

  test('opening a note from a tag-filtered list leaves the sidebar filtered', async ({ page }) => {
    await page.goto(`/tags/${TAG}`);
    await expect(page.locator(SIDEBAR_ROWS)).toHaveCount(TAGGED);
    await expect(page.locator(FILTER_CHIPS)).toHaveText([TAG]);

    const listRequests = watchListRequests(page);
    await page.locator(`${SIDEBAR_ROWS} a.link`).first().click();
    // The note is open in the main panel: this is the navigation whose effect on
    // the sidebar is the subject.
    await expect(page).toHaveURL(/\/notes\/tagged-note-\d$/);
    await expect(page.locator('main .note-content')).toBeVisible();
    await page.waitForTimeout(SETTLE);

    expect(listRequests, `the sidebar refetched ${listRequests.length} times`).toHaveLength(0);
    await expect(page.locator(FILTER_CHIPS), 'the filter chip vanished').toHaveText([TAG]);
    await expect(page.locator(SIDEBAR_ROWS), 'the sidebar reverted to every note')
      .toHaveCount(TAGGED);
  });

  // The other three routes the filter must outlive. The graph tab is the odd one
  // of them: it unmounts the note list entirely, so what is asserted there is
  // that the filter comes *back* with it rather than that it stayed on screen.
  test('the filter outlives the editor, a new note, and the graph tab', async ({ page }) => {
    await page.goto(`/tags/${TAG}`);
    await expect(page.locator(FILTER_CHIPS)).toHaveText([TAG]);

    await page.locator(`${SIDEBAR_ROWS} a.link`).first().click();
    await expect(page.locator('main .note-content')).toBeVisible();

    await page.locator('main').getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page).toHaveURL(/\/edit$/);
    await expect(page.locator(FILTER_CHIPS), 'the editor cleared the filter').toHaveText([TAG]);

    await page.goto(`/tags/${TAG}`);
    await page.locator('.sidebar-actions button[aria-label="New note"]').click();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.locator(FILTER_CHIPS), 'the new-note editor cleared the filter')
      .toHaveText([TAG]);

    await page.locator('.sidebar-tabs button', { hasText: 'Graph' }).click();
    await expect(page).toHaveURL(/\/graph$/);
    await expect(page.locator(FILTER_CHIPS), 'the note list is not mounted on the graph tab')
      .toHaveCount(0);
    // Leaving the graph returns the main panel to the note list, and it must be
    // the *filtered* list: this is a navigation to a list route, so the filter
    // survives only because that route is built from the filter itself.
    await page.locator('.sidebar-tabs button', { hasText: 'Notes' }).click();
    await expect(page).toHaveURL(new RegExp(`/tags/${TAG}$`));
    await expect(page.locator(FILTER_CHIPS), 'the filter did not come back with the list')
      .toHaveText([TAG]);
  });

  test('a list route still replaces a filter it finds in place', async ({ page }) => {
    await page.goto(`/tags/${TAG}`);
    await expect(page.locator(SIDEBAR_ROWS)).toHaveCount(TAGGED);

    // A tag chip on a note row is an in-app link to that tag's list — the
    // list→list navigation that must overwrite a non-empty filter rather than
    // being mistaken for the "leave it alone" case.
    await page.locator(`${SIDEBAR_ROWS} .tag-chips a[href$="/tags/${OTHER}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/tags/${OTHER}$`));
    await expect(page.locator(FILTER_CHIPS)).toHaveText([OTHER]);
    await expect(page.locator(SIDEBAR_ROWS)).toHaveCount(1);
  });

  test('the list routes still set the filter, so home clears it', async ({ page }) => {
    await page.goto(`/tags/${TAG}`);
    await expect(page.locator(SIDEBAR_ROWS)).toHaveCount(TAGGED);

    await page.locator(`${SIDEBAR_ROWS} a.link`).first().click();
    await expect(page.locator('main .note-content')).toBeVisible();

    // The brand block links to `/`, which is the list route that means "no tag
    // filter" — the one navigation that must still empty it. It is root-relative
    // and carries neither `download` nor `target`, so router.ts's click handler
    // takes it: a real SPA navigation, not a reload that would prove nothing.
    await page.locator('a.sidebar-brand').click();
    await expect(page.locator(FILTER_CHIPS), 'the filter outlived the route that clears it')
      .toHaveCount(0);
    await expect(page.locator(SIDEBAR_ROWS)).toHaveCount(TAGGED + UNTAGGED);
  });
});
