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

for (const view of ['read', 'preview']) {
  test(`wide tables scroll independently in ${view}`, async ({ page, request }) => {
    const columns = Array.from({ length: 12 }, (_, i) => `Column${i}LongHeading`);
    const content = [
      '| ' + columns.join(' | ') + ' |',
      '| ' + columns.map(() => '---').join(' | ') + ' |',
      '| ' + columns.map(() => 'Value').join(' | ') + ' |',
      '',
      ...Array.from({ length: 100 }, () => 'Text below the table.\n'),
      '| A | B |', '| --- | --- |', '| x | y |',
    ].join('\n');
    const response = await request.post('/api/v1/notes', { data: {
      title: `Wide table ${view}`, content,
    } });
    expect(response.status()).toBe(201);
    const { slug } = await response.json();
    try {
      await page.goto(`/notes/${slug}${view === 'preview' ? '/edit' : ''}`);
      const selector = view === 'preview' ? '.preview-pane .note-content' : 'main .note-content';
      const table = page.locator(`${selector} table`).first();
      await expect(table).toBeVisible();
      const scroll = page.getByRole('region', { name: 'Scrollable table' }).first();
      await scroll.focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      const result = await table.evaluate(table => {
        const note = table.closest('.note-content')!;
        const scroll = table.parentElement!;
        scroll.scrollLeft = scroll.scrollWidth;
        const last = table.querySelector('th:last-child')!.getBoundingClientRect();
        const box = scroll.getBoundingClientRect();
        return {
          moved: scroll.scrollLeft > 0,
          narrowTableFillsNote: Math.abs(note.querySelectorAll('table')[1].getBoundingClientRect().width -
            note.clientWidth) < 2,
          endVisible: last.right <= box.right + 1,
          tableInViewport: box.bottom < window.innerHeight,
          noteDoesNotScrollHorizontally: note.scrollWidth <= note.clientWidth,
          visibleAtEnd: table.contains(document.elementFromPoint(last.right - 4, last.top + 4)),
        };
      });
      expect(result).toEqual({ moved: true, narrowTableFillsNote: true, endVisible: true, tableInViewport: true,
        noteDoesNotScrollHorizontally: true, visibleAtEnd: true });
    } finally {
      await request.delete(`/api/v1/notes/${slug}`);
    }
  });
}
