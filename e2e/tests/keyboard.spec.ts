import { test, expect } from '@playwright/test';

test('note arrows move focus and Backspace returns without disturbing search', async ({ page, request }) => {
  const slugs: string[] = [];
  try {
    for (const title of ['Keyboard first', 'Keyboard second']) {
      const response = await request.post('/api/v1/notes', { data: { title, content: 'Keyboard test\n\n'.repeat(100) } });
      expect(response.status()).toBe(201);
      slugs.push((await response.json()).slug);
    }
    await page.goto('/');
    const search = page.getByRole('searchbox', { name: 'Filter by title' });
    const initialFilter = page.waitForResponse(response => response.url().includes('q=Keyboard&'));
    await search.fill('Keyboard');
    await initialFilter;
    const links = page.locator('.sidebar .note-row > a.link');
    await expect(links).toHaveCount(2);
    await links.first().focus();
    await page.keyboard.press('ArrowUp');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(links.last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(links.last()).toBeFocused();
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press('Enter');
    const pane = page.locator('main .note-view-scroll');
    await expect(pane).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(pane).toBeFocused();
    await page.keyboard.press('PageDown');
    await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('ArrowLeft');
    await expect(links.last()).toBeFocused();
    await search.focus();
    const filtered = page.waitForResponse(response => response.url().includes('q=Keyboar&')
      && response.request().method() === 'GET');
    await page.keyboard.press('Backspace');
    await expect(search).toHaveValue('Keyboar');
    await expect(page).toHaveURL(/\/notes\//);
    await filtered;
    await expect(links).toHaveCount(2);
    await links.last().focus();
    await page.keyboard.press('Backspace');
    await expect(page).toHaveURL(/\/$/);
    await expect(links.last()).toBeFocused();
  } finally {
    for (const slug of slugs) await request.delete(`/api/v1/notes/${slug}`);
  }
});

test('Escape uses editor Cancel and dismisses only its confirmation', async ({ page }) => {
  await page.goto('/new');
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  await title.fill('Unsaved keyboard note');
  await page.keyboard.press('Escape');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Leave', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/\/new$/);
  await expect(title).toHaveValue('Unsaved keyboard note');
});

test('overview titles support arrow navigation', async ({ page, request }) => {
  const slugs: string[] = [];
  try {
    for (const title of ['Arrow navigation one', 'Arrow navigation two']) {
      const response = await request.post('/api/v1/notes', { data: { title, content: '' } });
      expect(response.status()).toBe(201);
      slugs.push((await response.json()).slug);
    }
    await page.goto('/');
    const titles = page.locator('main .note-row > a.link');
    await expect(titles.first()).toBeVisible();
    await titles.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(titles.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(titles.first()).toBeFocused();
  } finally {
    for (const slug of slugs) await request.delete(`/api/v1/notes/${slug}`);
  }
});


test('Escape in editor pickers and sidebar does not cancel editing', async ({ page }) => {
  await page.goto('/new');
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  await title.fill('Keep editing');
  await page.getByRole('button', { name: 'Emoji', exact: true }).click();
  await expect(page.locator('.emoji-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.emoji-picker')).not.toBeVisible();
  await expect(page.getByRole('alertdialog')).not.toBeVisible();
  await expect(page).toHaveURL(/\/new$/);
  await page.getByRole('searchbox', { name: 'Full-text search', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).not.toBeVisible();
  await expect(title).toHaveValue('Keep editing');
  await page.locator('.tag-picker-input').fill('example');
  await page.keyboard.press('Escape');
  await expect(page.locator('.tag-picker-input')).toHaveValue('');
  await expect(page.getByRole('alertdialog')).not.toBeVisible();
});

test('tag arrows and Backspace preserve the filtered list', async ({ page, request }) => {
  const tags = ['keyboard-tag-one', 'keyboard-tag-two'];
  let slug: string | undefined;
  try {
    for (const tag of tags) {
      expect((await request.post('/api/v1/tags', { data: { slug: tag } })).status()).toBe(201);
    }
    const response = await request.post('/api/v1/notes', {
      data: { title: 'Keyboard tagged note', content: '', tags: [tags[0]] },
    });
    expect(response.status()).toBe(201);
    slug = (await response.json()).slug;
    await page.goto(`/tags/${tags[0]}`);
    const link = page.locator('.sidebar .note-row > a.link');
    await expect(link).toHaveCount(1);
    await link.focus();
    await page.keyboard.press('ArrowRight');
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main .note-view')).toBeVisible();
    await page.keyboard.press('Backspace');
    await expect(page).toHaveURL(new RegExp(`/tags/${tags[0]}$`));
    await expect(link).toBeFocused();
    await page.getByRole('tab', { name: 'Tags', exact: true }).click();
    const names = page.locator('.tag-manager-name');
    await expect(names.first()).toBeVisible();
    await names.first().focus();
    await page.keyboard.press('ArrowUp');
    await expect(names.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(names.nth(1)).toBeFocused();
    await names.last().focus();
    await page.keyboard.press('ArrowDown');
    await expect(names.last()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('main .note-row > a.link').first()).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/tags/${tags[0]}$`));
    await page.keyboard.press('ArrowLeft');
    await expect(names.last()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('main .note-row > a.link').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main .note-view-scroll')).toBeVisible();
    await names.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('main .note-view-scroll')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(names.first()).toBeFocused();
    await names.filter({ hasText: tags[1] }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('main .note-row')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(names.filter({ hasText: tags[1] })).toBeFocused();
  } finally {
    if (slug) await request.delete(`/api/v1/notes/${slug}`);
    for (const tag of tags) await request.delete(`/api/v1/tags/${tag}`);
  }
});

test('first note title keeps its focus outline inside both scrollports', async ({ page, request }) => {
  const response = await request.post('/api/v1/notes', {
    data: { title: 'Focus outline test', content: '' },
  });
  expect(response.status()).toBe(201);
  const { slug } = await response.json();
  try {
    await page.goto('/');
    for (const selector of ['.sidebar .note-row > a.link', 'main .note-row > a.link']) {
      const title = page.locator(selector).first();
      await title.focus();
      await expect(title).toBeFocused();
      await expect(title).toHaveCSS('outline-style', 'solid');
      const geometry = await title.evaluate(el => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const scroll = el.closest('.notes-list-scroll, .overview-scroll')!.getBoundingClientRect();
        const extent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        const ringInset = -parseFloat(style.outlineOffset);
        const textGap = Math.min(parseFloat(style.paddingLeft), parseFloat(style.paddingRight)) - ringInset;
        return { textGap, top: box.top - extent, left: box.left - extent,
          right: box.right + extent, bottom: box.bottom + extent,
          scrollTop: scroll.top, scrollLeft: scroll.left, scrollRight: scroll.right, scrollBottom: scroll.bottom };
      });
      expect(geometry.textGap).toBeGreaterThanOrEqual(2);
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.scrollTop);
      expect(geometry.left).toBeGreaterThanOrEqual(geometry.scrollLeft);
      expect(geometry.right).toBeLessThanOrEqual(geometry.scrollRight);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.scrollBottom);
    }
  } finally {
    await request.delete(`/api/v1/notes/${slug}`);
  }
});

test('tag focus outline stays inside the list and clear of its label', async ({ page, request }) => {
  const slug = 'focus-outline-tag';
  expect((await request.post('/api/v1/tags', { data: { slug } })).status()).toBe(201);
  try {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Tags', exact: true }).click();
    const tag = page.locator('.tag-manager-name').filter({ hasText: slug });
    await page.keyboard.press('Tab');
    await tag.focus();
    await expect(tag).toBeFocused();
    await expect(tag).toHaveCSS('outline-style', 'solid');
    const geometry = await tag.evaluate(el => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const scroll = el.closest('.tag-list')!.getBoundingClientRect();
      const extent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      return { left: box.left - extent, right: box.right + extent,
        scrollLeft: scroll.left, scrollRight: scroll.right,
        gap: parseFloat(style.paddingLeft) + parseFloat(style.outlineOffset) };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.scrollLeft);
    expect(geometry.right).toBeLessThanOrEqual(geometry.scrollRight);
    expect(geometry.gap).toBeGreaterThanOrEqual(2);
  } finally {
    await request.delete(`/api/v1/tags/${slug}`);
  }
});
