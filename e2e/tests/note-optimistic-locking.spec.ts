import { test, expect } from '@playwright/test';

// MyNotes-local: the editor must send timestamp ETags and refresh them after
// saves and conflict reloads. API-only tests cannot catch an editor retaining
// the removed numeric version field.
test('editor saves with timestamp ETags and reloads after a concurrent edit', async ({ page, request }) => {
  const created = await request.post('/api/v1/notes', {
    data: { title: 'Timestamp lock', slug: 'timestamp-lock', content: 'Initial content' },
  });
  expect(created.status()).toBe(201);
  const original = await created.json();
  const noteURL = '/api/v1/notes/timestamp-lock';
  try {
    await page.goto('/notes/timestamp-lock');
    await page.locator('.note-header-left').click();
    await page.getByLabel('Title', { exact: true }).fill('First edit');
    const savedPromise = page.waitForResponse(r => r.url().endsWith(noteURL) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = await savedPromise;
    expect(saved.status()).toBe(200);
    expect(await saved.request().headerValue('If-Match')).toBe(`"${original.updated_at}"`);
    const first = await saved.json();
    expect(saved.headers()['etag']).toBe(`"${first.updated_at}"`);
    expect(Date.parse(first.updated_at)).toBeGreaterThan(Date.parse(original.updated_at));

    await page.locator('.note-header-left').click();
    await page.getByLabel('Title', { exact: true }).fill('Local edit');
    const concurrent = await request.patch(noteURL, { data: { title: 'Concurrent edit' } });
    expect(concurrent.status()).toBe(200);
    const concurrentNote = await concurrent.json();
    const rejectedPromise = page.waitForResponse(r => r.url().endsWith(noteURL) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await rejectedPromise).status()).toBe(412);
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Discard my edits & reload' }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Concurrent edit');
    await page.getByLabel('Title', { exact: true }).fill('After reload');
    const reloadedSavePromise = page.waitForResponse(r => r.url().endsWith(noteURL) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const reloadedSave = await reloadedSavePromise;
    expect(reloadedSave.status()).toBe(200);
    expect(await reloadedSave.request().headerValue('If-Match')).toBe(`"${concurrentNote.updated_at}"`);
  } finally {
    await request.delete(noteURL);
  }
});
