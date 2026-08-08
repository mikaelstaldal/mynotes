import { test, expect, type APIRequestContext } from '@playwright/test';

// The sidebar note list must not reload itself — and so must not throw away the
// reader's scroll position — unless the query actually changed. Both tests here
// exist because it did, and because the assertion that caught it could not be
// relied on to catch it again: `sidebar-footer.spec.ts`'s volume test noticed
// only by landing inside the 300 ms debounce window by chance, which is why it
// went red in CI while passing locally for weeks.
//
// So neither test below measures from inside that window. Each waits *past* it
// and then asserts what must not have happened, which is the same invariant with
// no race in it. Unlike the other two specs in this directory, this one is
// MyNotes-local: it implements no cross-repo contract.
test.describe('Note list refetching', () => {
  const NOTES_API = '/api/v1/notes';
  // A list request, as opposed to the single-note GET that the note view issues:
  // only the list carries a query string.
  const LIST_QUERY = `${NOTES_API}?`;
  // Comfortably past the 300 ms debounce in web/ts/views/NoteList.tsx, so a
  // surplus load has either happened by the time we assert or is not coming.
  const PAST_DEBOUNCE = 800;

  const resetNotes = async (request: APIRequestContext) => {
    for (let pass = 0; pass < 20; pass++) {
      const { notes } = await (await request.get(NOTES_API, { params: { limit: 200 } })).json();
      if (notes.length === 0) break;
      for (const note of notes) {
        const gone = await request.delete(`${NOTES_API}/${note.slug}`);
        expect(gone.ok(), `deleting ${note.slug}: ${gone.status()}`).toBe(true);
      }
    }
  };

  // Enough rows to overflow the sidebar's scrollport, so "the list kept its
  // scroll position" is a statement about something that could have moved.
  const seedNotes = async (request: APIRequestContext, count: number) => {
    for (let i = 0; i < count; i++) {
      const made = await request.post(NOTES_API, {
        data: {
          title: `Volume note ${i} with a reasonably long title`,
          content: `Body of note ${i}.`,
        },
      });
      expect(made.ok(), `creating note ${i}: ${made.status()}`).toBe(true);
    }
  };

  test.beforeEach(async ({ request }) => {
    await resetNotes(request);
    await seedNotes(request, 40);
  });

  // The mount case — the one that broke CI. The debounce timer fires once on
  // mount and commits the value the list already started with; committing it as
  // a fresh object identity re-ran the load effect, which clears `rows`.
  //
  // Counted on a note route rather than the list route, deliberately: on `/` the
  // main pane's overview issues an identical list request of its own, so the
  // expected count would be "two, for reasons outside this component" and would
  // move whenever an unrelated pane changed. A note route mounts the sidebar
  // list alone — the note view fetches only its own note, which has no query
  // string — so the number below means exactly one thing.
  test('the settling debounce does not reload a list whose query never changed', async ({ page, request }) => {
    const made = await request.post(NOTES_API, { data: { title: 'Anchor note', content: 'Body.' } });
    expect(made.ok()).toBe(true);
    const { slug } = await made.json();

    const listRequests: string[] = [];
    page.on('request', r => {
      if (r.url().includes(LIST_QUERY)) listRequests.push(r.url());
    });

    await page.goto(`/notes/${slug}`);
    await expect(page.locator('.notes-list-scroll .note-row').first()).toBeVisible();
    await page.waitForTimeout(PAST_DEBOUNCE);

    expect(listRequests, `the list loaded ${listRequests.length} times, not once`)
      .toHaveLength(1);
  });

  // The same defect reached through the input: the mode is decided on the
  // trimmed text but the query was committed untrimmed, so a trailing space —
  // which both server branches normalise away — read as a new query and reset
  // the list to fetch a byte-identical result.
  test('a whitespace-only edit to the query does not reset the list', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.notes-list-scroll .note-row').first()).toBeVisible();
    // Let the mount debounce settle first, so what is measured below is the
    // effect of the keystroke and nothing else.
    await page.waitForTimeout(PAST_DEBOUNCE);

    const list = page.locator('.notes-list-scroll');
    const scrolled = await list.evaluate(el => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(scrolled, 'the list did not scroll — nothing was put at risk').toBeGreaterThan(0);

    const listRequests: string[] = [];
    page.on('request', r => {
      if (r.url().includes(LIST_QUERY)) listRequests.push(r.url());
    });

    await page.locator('input[aria-label="Full-text search"]').fill(' ');
    await page.waitForTimeout(PAST_DEBOUNCE);

    expect(listRequests, 'a trailing space refetched the list').toHaveLength(0);
    expect(await list.evaluate(el => el.scrollTop), 'the list lost its scroll position')
      .toBe(scrolled);
  });
});
