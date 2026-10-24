import { test, expect } from '@playwright/test';

for (const view of ['read', 'preview']) {
  test(`borrowed overlay classes stay inside the note in ${view}`, async ({ page, request }) => {
    const response = await request.post('/api/v1/notes', { data: {
      title: `Overlay containment ${view}`,
      content: '<a href="https://attacker.invalid/login"><svg class="dialog-overlay" width="100%" height="100%">' +
        '<rect width="100%" height="100%" fill="white"/>' +
        '<text x="40" y="80" font-size="24">Session expired</text></svg></a>\n\nOrdinary text.',
    } });
    expect(response.status()).toBe(201);
    const { slug } = await response.json();
    try {
      await page.goto(`/notes/${slug}${view === 'preview' ? '/edit' : ''}`);
      const selector = view === 'preview' ? '.preview-pane .note-content' : 'main .note-content';
      await expect(page.locator(`${selector} svg.dialog-overlay`)).toBeAttached();
      const result = await page.locator(selector).evaluate(note => {
        const svg = note.querySelector('svg')!;
        const box = note.getBoundingClientRect();
        const overlay = svg.getBoundingClientRect();
        const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
        const x = sidebar.left + sidebar.width / 2;
        const y = sidebar.top + sidebar.height / 2;
        return {
          position: getComputedStyle(svg).position,
          anchored: Math.abs(overlay.left - box.left) < 1 && Math.abs(overlay.top - box.top) < 1,
          escapes: [[box.left - 4, box.top + 1], [box.right + 4, box.top + 1],
            [box.left + 1, box.top - 4], [box.left + 1, box.bottom + 4]]
            .some(([x, y]) => svg.contains(document.elementFromPoint(x, y))),
          coversSidebar: note.contains(document.elementFromPoint(x, y)),
        };
      });
      // Keep the dangerous class active: this tests containment, not sanitization.
      expect(result.position).toBe('fixed');
      expect(result.anchored).toBe(true);
      expect(result.escapes).toBe(false);
      expect(result.coversSidebar).toBe(false);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.locator('.settings-overlay')).toBeVisible();
    } finally {
      await request.delete(`/api/v1/notes/${slug}`);
    }
  });
}

test('wide note content remains reachable by scrolling', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const note = document.createElement('div');
    note.className = 'note-content';
    note.style.width = '200px';
    const table = document.createElement('table');
    const cell = table.insertRow().insertCell();
    cell.textContent = 'wide'.repeat(200);
    note.append(table);
    document.body.append(note);
    note.scrollLeft = note.scrollWidth;
    const result = {
      scrollable: getComputedStyle(note).overflowX === 'auto',
      moved: note.scrollLeft > 0,
      endVisible: cell.getBoundingClientRect().right <= note.getBoundingClientRect().right,
    };
    note.remove();
    return result;
  });
  expect(result).toEqual({ scrollable: true, moved: true, endVisible: true });
});
