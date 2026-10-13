import { test, expect } from '@playwright/test';

const form = { client_id: 'mynotes-token', name: 'E2E device', lifetime: '1m' };
const grantType = 'urn:ietf:params:oauth:grant-type:device_code';

for (const theme of ['light', 'dark']) {
  test(`dedicated consent page reviews whole-API access and closes or falls back (${theme})`, async ({ page, request }) => {
    await page.addInitScript(theme => {
      localStorage.setItem('mynotes-settings', JSON.stringify({ theme }));
      const state = window as unknown as Window & { closeAttempts: number };
      state.closeAttempts = 0;
      window.close = () => { state.closeAttempts++; };
    }, theme);
    const authorization = await request.post('/api/v1/oauth/device_authorization', { form });
    expect(authorization.status()).toBe(200);
    const grant = await authorization.json();
    await page.goto(grant.verification_uri_complete);
    await expect(page.getByRole('heading', { name: 'MyNotes — device login' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.sidebar, .settings-dialog, .toolbar')).toHaveCount(0);
    await expect(page.getByText('E2E device', { exact: true })).toBeVisible();
    await expect(page.getByText(grant.user_code, { exact: true })).toBeVisible();
    await expect(page.getByText('Requester (IP | User-Agent)', { exact: true })).toBeVisible();
    await expect(page.getByText(/Read-only access to the whole MyNotes API/)).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review request' })).toHaveCount(0);
    await expect(page.getByLabel('User code', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Granted lifetime')).toHaveValue('1m');
    expect((await request.get('/api/v1/oauth/device/' + grant.user_code)).status()).toBe(200);
    await page.getByLabel('Granted lifetime').fill('99999d');
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    await page.getByLabel('Granted lifetime').fill('2m');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Approved.');
    await expect(page.getByText('You can close this tab.')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as Window & { closeAttempts: number }).closeAttempts)).toBe(1);
    const issued = await request.post('/api/v1/oauth/token', { form: { client_id: form.client_id, device_code: grant.device_code, grant_type: grantType } });
    expect(issued.status()).toBe(200);
    const token = await issued.json();
    expect(token.scope).toBe('');
    expect(token.expires_in).toBeGreaterThan(60);
    expect(token.expires_in).toBeLessThanOrEqual(120);
    await request.delete('/api/v1/tokens/' + token.slug);
  });
}

for (const approve of [true, false]) {
  test(`script-opened consent page closes after ${approve ? 'approval' : 'denial'}`, async ({ page, request }) => {
    const authorization = await request.post('/api/v1/oauth/device_authorization', { form });
    expect(authorization.status()).toBe(200);
    const grant = await authorization.json();
    await page.goto('/device-approval.html');
    const popupPromise = page.waitForEvent('popup');
    await page.evaluate(url => window.open(url, '_blank'), grant.verification_uri_complete);
    const popup = await popupPromise;
    await expect(popup.getByText('E2E device', { exact: true })).toBeVisible();
    await Promise.all([popup.waitForEvent('close'), popup.getByRole('button', { name: approve ? 'Approve' : 'Deny', exact: true }).click()]);
    const result = await request.post('/api/v1/oauth/token', { form: { client_id: form.client_id, device_code: grant.device_code, grant_type: grantType } });
    expect(result.status()).toBe(approve ? 200 : 400);
    const data = await result.json();
    if (approve) await request.delete('/api/v1/tokens/' + data.slug);
    else expect(data.error).toBe('access_denied');
  });
}

test('lookup and decision errors retain recoverable consent, without closing', async ({ page, request }) => {
  const authorization = await request.post('/api/v1/oauth/device_authorization', { form });
  const grant = await authorization.json();
  await page.addInitScript(() => {
    const state = window as unknown as Window & { closeAttempts: number };
    state.closeAttempts = 0; window.close = () => { state.closeAttempts++; };
  });
  let failLookup = true;
  await page.route('**/api/v1/oauth/device/*', async route => {
    if (route.request().method() === 'GET' && failLookup) {
      failLookup = false;
      await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"lookup failed"}' });
    } else if (route.request().method() === 'POST') {
      await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"decision failed"}' });
    } else await route.continue();
  });
  await page.goto(grant.verification_uri_complete);
  await expect(page.getByRole('alert')).toContainText('lookup failed');
  await expect(page.getByLabel('User code', { exact: true })).toHaveValue(grant.user_code);
  await page.getByRole('button', { name: 'Review request' }).click();
  await expect(page.getByText('E2E device', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('decision failed');
  await expect(page.getByLabel('Granted lifetime')).toHaveValue('1m');
  expect(await page.evaluate(() => (window as unknown as Window & { closeAttempts: number }).closeAttempts)).toBe(0);
  expect((await request.get('/api/v1/oauth/device/' + grant.user_code)).status()).toBe(200);
  await page.unroute('**/api/v1/oauth/device/*');
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Denied.');
  const result = await request.post('/api/v1/oauth/token', { form: { client_id: form.client_id, device_code: grant.device_code, grant_type: grantType } });
  expect((await result.json()).error).toBe('access_denied');
});

test('consent and API requests retain the deployment prefix', async ({ page, request }) => {
  const authorization = await request.post('/api/v1/oauth/device_authorization', { form });
  const grant = await authorization.json();
  await page.addInitScript(() => { window.close = () => {}; });
  const apiPaths: string[] = [];
  await page.route('**/nested/**', async route => {
    const target = new URL(route.request().url());
    if (target.pathname.includes('/api/v1/')) apiPaths.push(target.pathname);
    target.pathname = target.pathname.replace(/^\/nested/, '');
    const response = await route.fetch({ url: target.toString() });
    if (target.pathname === '/device-approval.html') {
      await route.fulfill({ response, body: (await response.text()).replace('<base href="/">', '<base href="/nested/">') });
    } else await route.fulfill({ response });
  });
  const url = new URL(grant.verification_uri_complete); url.pathname = '/nested' + url.pathname;
  await page.goto(url.toString());
  await expect(page.getByText('E2E device', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Granted lifetime')).toHaveValue('1m');
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Denied.');
  expect(apiPaths).toEqual(['/nested/api/v1/oauth/device/' + grant.user_code, '/nested/api/v1/oauth/device/' + grant.user_code]);
  await request.post('/api/v1/oauth/token', { form: { client_id: form.client_id, device_code: grant.device_code, grant_type: grantType } });
});


test('an expired or already decided consent clears stale approval and permits another code', async ({ page, request }) => {
  const authorization = await request.post('/api/v1/oauth/device_authorization', { form });
  const grant = await authorization.json();
  await page.addInitScript(() => { window.close = () => {}; });
  await page.goto(grant.verification_uri_complete);
  await expect(page.getByText('E2E device', { exact: true })).toBeVisible();
  expect((await request.post('/api/v1/oauth/device/' + grant.user_code, { data: { approve: false } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unknown, expired, or already decided user code.');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('User code', { exact: true })).toHaveValue(grant.user_code);
  await expect(page.getByRole('button', { name: 'Review request' })).toBeEnabled();
  await request.post('/api/v1/oauth/token', { form: { client_id: form.client_id, device_code: grant.device_code, grant_type: grantType } });
});
