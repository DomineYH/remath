// One journey through the walking skeleton (#22): guards, signup → practice, logout/login, admin login, language and theme.
import { expect, test } from '@playwright/test';

const NO_GROUP = 'tester1 is not in any group';

test('teacher and admin walking skeleton', async ({ page }) => {
  // 1. unauthenticated guards
  await page.goto('/practice');
  await expect(page).toHaveURL('/');
  await page.goto('/admin/scenarios');
  await expect(page).toHaveURL('/admin');

  // 2. create account: live nickname error, live password rules, lands on /practice with the no-group notice
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
  const nick = page.getByLabel('Nickname');
  await nick.fill('a@b');
  await expect(page.getByRole('alert')).toContainText('look like an email or phone number');
  await nick.fill('tester1');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const rules = page.locator('.pwrules li');
  const pw = page.getByLabel('Password', { exact: true });
  await expect(rules.locator('.ok, .no')).toHaveCount(0);   // neutral when empty
  await pw.fill('abcd');
  await expect(rules.nth(0)).toHaveClass('no');
  await expect(rules.nth(1)).toHaveClass('no');
  await expect(rules.nth(2)).toHaveClass('ok');
  await pw.fill('abcd1');
  await expect(rules.nth(1)).toHaveClass('ok');
  await expect(rules.nth(0)).toHaveClass('no');
  await pw.fill('abcd1234');
  await expect(rules.nth(0)).toHaveClass('ok');
  await page.getByLabel('Confirm password').fill('abcd1234');
  await page.getByRole('button', { name: 'Create account and start' }).click();
  await expect(page).toHaveURL('/practice');
  await expect(page.getByText(NO_GROUP)).toBeVisible();

  // 3. log out → log in again → logged-in visits to / bounce home; teacher login does not open admin
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/');
  await page.getByLabel('Nickname').fill('tester1');
  await page.getByLabel('Password', { exact: true }).fill('abcd1234');
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/practice');
  await expect(page.getByText(NO_GROUP)).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL('/practice');
  await page.goto('/admin/scenarios');
  await expect(page).toHaveURL('/admin');

  // 4. admin: one error line for a wrong password, then the scenarios tab with 5 subnav tabs
  await page.getByLabel('Admin ID').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('wrong1234');
  await page.getByRole('button', { name: 'Sign in as admin' }).click();
  await expect(page.getByRole('alert')).toHaveText('ID or password is incorrect.');
  await page.getByLabel('Password', { exact: true }).fill('E2eAdmin123');
  await page.getByRole('button', { name: 'Sign in as admin' }).click();
  await expect(page).toHaveURL('/admin/scenarios');
  const subnav = page.getByRole('navigation', { name: 'Admin menu' });
  await expect(subnav.getByRole('link')).toHaveText(['Scenarios', 'Users', 'Groups', 'Conversations', 'AI settings']);
  await expect(subnav.getByRole('link', { name: 'Scenarios' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('No scenarios yet.')).toBeVisible();
  await page.goto('/admin');
  await expect(page).toHaveURL('/admin/scenarios');

  // 5. 한│EN and theme toggles, both kept across a reload
  await page.getByRole('group', { name: 'Interface language' }).getByRole('button', { name: '한' }).click();
  await expect(page.getByRole('heading', { name: '시나리오 관리' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  const before = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const flipped = before === 'dark' ? 'light' : 'dark';
  await page.getByRole('banner').getByRole('button', { name: before === 'dark' ? '라이트 모드' : '다크 모드' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', flipped);
  await page.reload();
  await expect(page.getByRole('heading', { name: '시나리오 관리' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', flipped);
});
