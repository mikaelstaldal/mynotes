import { test, expect, type Page } from '@playwright/test';

// The sidebar footer in a DEMO build (`-demo-server`), which the `chromium-demo`
// project in playwright.config.ts points at — a second process on 8092, because
// a demo has no database and no REST API and so cannot be a route on the server
// the rest of the suite uses.
//
// What this file is for, and what it is not:
//
//   * It is NOT this repo's half of the sidebar-footer contract. That is
//     `sidebar-footer.spec.ts`, it runs against the real binary, and it owns
//     every coordinate, colour and computed value. Nothing here asserts a
//     number from `../mysuite`, `spec/sidebar-footer.md` — adding one would put
//     the contract in two files in this repo, which is what that spec's own
//     header warns against.
//   * It IS the check that the demo build offers the same pair of CONTROLS, and
//     that the second one does something when clicked. Settings used to be
//     rendered only when `!isDemo()`; a demo showed one control where every
//     other build shows two. That claim — "the pair exists here too" — is
//     cheap to assert and was previously asserted by nothing, in any of the
//     three apps (`../mysuite`, `spec/sidebar-footer.md` §10.9).
//
// The dialog's *contents* are this app's own business, not the contract's: a
// demo has no server to relay a MyMail message, so the modal explains that
// instead of offering the field (spec/REQUIREMENTS.md § Demo Mode).

const THEME = '.sidebar-footer-actions .theme-toggle';
const SETTINGS = '.sidebar-footer-actions .settings-open';
const DIALOG = '.settings-dialog';

// A demo build shows a one-time notice on first visit in a browser, and every
// test here gets a fresh context — so it is up every time and would swallow the
// first click. Dismissing it is setup, not a test; `demo-notice-seen` lives in
// localStorage, which a fresh context does not carry over.
async function openDemo(page: Page): Promise<void> {
  await page.goto('/');
  // The app renders only once the service worker is installed and in control,
  // so waiting for the footer waits for the demo backend to be up.
  await expect(page.locator('.sidebar-footer')).toBeVisible();
  const notice = page.locator('.demo-dialog');
  if (await notice.count()) {
    await notice.getByRole('button', { name: 'OK' }).click();
    await expect(notice).toHaveCount(0);
  }
}

test.describe('Sidebar footer in a demo build', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('is a demo, and shows both controls', async ({ page }) => {
    // Assert the build first. Without this, every expectation below would also
    // pass against the real server — the failure that reads as a pass, and the
    // one this file is most exposed to, since its whole subject is a build
    // difference.
    await expect(page.locator('.demo-badge')).toBeVisible();

    await expect(page.locator(THEME)).toBeVisible();
    await expect(page.locator(SETTINGS)).toBeVisible();
  });

  test('Settings opens a dialog holding no field', async ({ page }) => {
    await page.locator(SETTINGS).click();

    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // The MyMail integration is never offered in a demo (REQUIREMENTS
    // § Demo Mode), so there must be nothing here that could set the URL — not
    // merely a hidden or disabled field.
    await expect(dialog.locator('input')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Save' })).toHaveCount(0);

    // Prose, not an empty box: the dialog says why it holds nothing, and says
    // it through the description a screen reader is given.
    const describedBy = await dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toContainText('nothing to configure');
  });

  test('focus lands on the dialog rather than staying behind it', async ({ page }) => {
    await page.locator(SETTINGS).click();
    await expect(page.locator(DIALOG)).toBeVisible();

    // The only focusable control in this variant. Focus has to move off the
    // sidebar button, or Escape and Enter act on the page behind the overlay.
    await expect(page.locator(DIALOG).getByRole('button', { name: 'Close' })).toBeFocused();
  });

  for (const [name, dismiss] of [
    ['the Close button', async (page: Page) =>
      page.locator(DIALOG).getByRole('button', { name: 'Close' }).click()],
    ['Escape', async (page: Page) => page.keyboard.press('Escape')],
    // Top-left of the overlay: outside the centred dialog box in every viewport
    // this suite runs at, and the dialog stops the click from reaching the
    // overlay when it lands inside.
    ['a click outside', async (page: Page) =>
      page.locator('.settings-overlay').click({ position: { x: 5, y: 5 } })],
  ] as const) {
    test(`${name} dismisses it`, async ({ page }) => {
      await page.locator(SETTINGS).click();
      // Waiting for the dialog to be VISIBLE is not enough, and the difference
      // is only visible on the Escape row: the keydown listener is registered
      // in an effect, so a key pressed in the frame between paint and that
      // effect is dropped. Measured — with no wait the dialog survives Escape,
      // with 50ms it does not. Waiting for focus is the meaningful barrier
      // rather than a sleep: the focus call lives in the parent of the
      // component holding the listener, and effects flush child-first, so the
      // button being focused means the listener is already attached.
      await expect(page.locator(DIALOG).getByRole('button', { name: 'Close' })).toBeFocused();

      await dismiss(page);
      await expect(page.locator(DIALOG)).toHaveCount(0);
    });
  }
});
