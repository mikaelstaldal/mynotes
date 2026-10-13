// Settings separates preferences from token management; revoke must be confirmed.
import { test, expect } from '@playwright/test';

test('API Tokens tab lists whole-API access and expiry and confirms revocation', async ({ page, request }) => {
  const created = await request.post('/api/v1/tokens', { data: { name: 'Settings token', expires_at: new Date(Date.now() + 3600000).toISOString() } });
  expect(created.status()).toBe(201);
  const token = await created.json();
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('.settings-dialog');
  await expect(settings.getByRole('tab', { name: 'Integration' })).toHaveAttribute('aria-selected', 'true');
  await expect(settings.getByLabel('MyMail URL')).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Existing tokens' })).not.toBeVisible();
  await settings.getByRole('tab', { name: 'API Tokens', exact: true }).click();
  await expect(settings.getByLabel('MyMail URL')).not.toBeVisible();
  const row = settings.locator('.api-token-list li').filter({ hasText: token.slug });
  await expect(row).toContainText('Settings token');
  await expect(settings.getByText(/read-only access to the whole MyNotes API/)).toBeVisible();
  await expect(row).toContainText('Expires');
  await expect(settings.getByText(token.token, { exact: true })).toHaveCount(0);
  const review = settings.getByRole('button', { name: 'Review request' });
  const code = settings.getByLabel('User code', { exact: true });
  await expect(review).toBeDisabled();
  await expect(review).toHaveCSS('opacity', '0.55');
  await code.fill('   ');
  await expect(review).toBeDisabled();
  await code.fill('BCDF-GHJK');
  await expect(review).toBeEnabled();
  await settings.getByRole('tab', { name: 'Integration' }).click();
  await settings.getByRole('tab', { name: 'API Tokens', exact: true }).click();
  await expect(code).toHaveValue('BCDF-GHJK');
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Revoke API token' });
  await expect(confirmation).toContainText('immediately lose access');
  await confirmation.getByRole('button', { name: 'Keep' }).click();
  await expect(row).toBeVisible();
  await page.route('**/api/v1/tokens/*', async route => {
    if (route.request().method() === 'DELETE') await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"revoke failed"}' });
    else await route.continue();
  });
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('revoke failed');
  await expect(row).toBeVisible();
  await page.unroute('**/api/v1/tokens/*');
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(row).toHaveCount(0);
  const access = await request.get('/api/v1/notes', { headers: { Authorization: `Bearer ${token.token}` } });
  expect(access.status()).toBe(401);
  await settings.getByRole('tab', { name: 'API Tokens', exact: true }).press('ArrowLeft');
  await expect(settings.getByRole('tab', { name: 'Integration' })).toBeFocused();
  await expect(settings.getByLabel('MyMail URL')).toBeVisible();

});

test('token list errors do not claim there are no tokens', async ({ page }) => {
  await page.route('**/api/v1/tokens', route => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"list failed"}' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'API Tokens', exact: true }).click();
  const settings = page.locator('.settings-dialog');
  await expect(settings.getByRole('alert')).toContainText('list failed');
  await expect(settings.getByText('No API tokens.', { exact: true })).toHaveCount(0);
});

test('revoking a token already removed elsewhere removes the stale row', async ({ page, request }) => {
  const created = await request.post('/api/v1/tokens', { data: { name: 'Stale token', expires_at: new Date(Date.now() + 3600000).toISOString() } });
  expect(created.status()).toBe(201);
  const token = await created.json();
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'API Tokens', exact: true }).click();
  const row = page.locator('.api-token-list li').filter({ hasText: token.slug });
  await expect(row).toBeVisible();
  expect((await request.delete('/api/v1/tokens/' + token.slug)).status()).toBe(204);
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Revoke API token' }).getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('.settings-dialog').getByRole('alert')).toHaveCount(0);
});

test('switching settings tabs preserves a loaded device request and edits', async ({ page, request }) => {
  const authorization = await request.post('/api/v1/oauth/device_authorization', { form: { client_id: 'mynotes-token', name: 'Tab switching', lifetime: '1m' } });
  expect(authorization.status()).toBe(200);
  const grant = await authorization.json();
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'API Tokens', exact: true }).click();
  const settings = page.locator('.settings-dialog');
  await settings.getByLabel('User code', { exact: true }).fill(grant.user_code);
  await settings.getByRole('button', { name: 'Review request' }).click();
  await expect(settings.getByText('Tab switching', { exact: true })).toBeVisible();
  await settings.getByLabel('Granted lifetime').fill('2m');
  await settings.getByRole('tab', { name: 'Integration' }).click();
  await expect(settings.getByText('Tab switching', { exact: true })).not.toBeVisible();
  await settings.getByRole('tab', { name: 'API Tokens', exact: true }).click();
  await expect(settings.getByText('Tab switching', { exact: true })).toBeVisible();
  await expect(settings.getByLabel('Granted lifetime')).toHaveValue('2m');
  await expect(settings.getByRole('checkbox')).toHaveCount(0);
  await settings.getByRole('button', { name: 'Deny', exact: true }).click();
  const result = await request.post('/api/v1/oauth/token', { form: { client_id: 'mynotes-token', device_code: grant.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
  expect((await result.json()).error).toBe('access_denied');
});
