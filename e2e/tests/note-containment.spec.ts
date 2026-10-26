import { test, expect } from '@playwright/test';

for (const view of ['read', 'preview']) {
  test(`borrowed overlay classes are removed in ${view}`, async ({ page, request }) => {
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
      await expect(page.locator(`${selector} svg`)).toBeAttached();
      const result = await page.locator(selector).evaluate(note => {
        const svg = note.querySelector('svg')!;
        const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
        const x = sidebar.left + sidebar.width / 2;
        const y = sidebar.top + sidebar.height / 2;
        return {
          position: getComputedStyle(svg).position,
          classes: svg.getAttribute('class'),
          coversSidebar: note.contains(document.elementFromPoint(x, y)),
        };
      });
      expect(result.position).not.toBe('fixed');
      expect(result.classes).toBeNull();
      expect(result.coversSidebar).toBe(false);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.locator('.settings-overlay')).toBeVisible();
    } finally {
      await request.delete(`/api/v1/notes/${slug}`);
    }
  });
}

for (const view of ['read', 'preview']) {
  test(`Markdown table retains its original layout in ${view}`, async ({ page, request }) => {
    await page.setViewportSize({ width: view === 'read' ? 1920 : 3200, height: 1080 });
    const content = [
      '| Column 1 | Column 2 | Column 3 | Column 4 | Column 5 |',
      '| --- | --- | --- | --- | --- |',
      '| aaaaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbb | cccccccccccccccccc | ddddddddddddddddddddd | eeeeeeeeeeeeeeeeeeee |',
    ].join('\n');
    const response = await request.post('/api/v1/notes', { data: { title: `Markdown table ${view}`, content } });
    expect(response.status()).toBe(201);
    const { slug } = await response.json();
    try {
      await page.goto(`/notes/${slug}${view === 'preview' ? '/edit' : ''}`);
      const selector = view === 'preview' ? '.preview-pane .note-content' : 'main .note-content';
      const table = page.locator(`${selector} table`);
      await expect(table).toBeVisible();
      const result = await table.evaluate(table => {
        const note = table.closest('.note-content')!;
        const last = table.querySelector('td:last-child')!.getBoundingClientRect();
        return {
          nativeTable: getComputedStyle(table).display === 'table',
          uncontained: getComputedStyle(note).contain === 'none',
          noWrapper: table.parentElement === note,
          notScrolled: note.scrollLeft === 0 && table.scrollLeft === 0,
          wholeTableVisible: table.contains(document.elementFromPoint(last.right - 4, last.top + 4)),
        };
      });
      expect(result).toEqual({ nativeTable: true, uncontained: true, noWrapper: true,
        notScrolled: true, wholeTableVisible: true });
    } finally {
      await request.delete(`/api/v1/notes/${slug}`);
    }
  });
}
