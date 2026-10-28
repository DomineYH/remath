// #27 · AI settings (I-48): prefix detection → save → masked KeyBox only, a model's own effort list as a radiogroup, sharing a key;
// and the scenario card "Chats CSV" (I-43) once the scenario has a session.
import { expect, test } from '@playwright/test';

const ANT = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123WXYZ';

test.beforeEach(async ({ page }) => {
  await page.goto('/admin');
  await page.getByLabel('Admin ID').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('E2eAdmin123');
  await page.getByRole('button', { name: 'Sign in as admin' }).click();
  await expect(page).toHaveURL('/admin/scenarios');
});

test('AI settings: key → provider → model → effort; save keeps only the mask; another bot shares the key', async ({ page }) => {
  await page.getByRole('navigation', { name: 'Admin menu' }).getByRole('link', { name: 'AI settings' }).click();
  await expect(page).toHaveURL('/admin/ai');
  const tiles = page.locator('.ai-tile');
  await expect(tiles).toHaveText([/Student bot.*Not set.*Key needed/, /Mentor bot.*Not set/, /Analysis bot.*Not set/]);

  const student = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Student bot' }) });
  const key = student.getByLabel('Enter API key');
  await key.fill('pk-nope-123456789');
  await expect(student.getByText('Unrecognized key format.', { exact: false })).toBeVisible();
  await expect(student.getByRole('button', { name: 'Save' })).toBeDisabled();
  await key.fill(ANT);
  await expect(student.getByText('Recognized as Anthropic key')).toBeVisible();
  const model = student.getByLabel(/^Model/);
  await expect(model).toHaveValue('claude-fable-5-1');                                   // recommended first pick
  await expect(model.locator('option', { hasText: 'recommended' })).toHaveText('claude-fable-5-1 · recommended');
  const effort = student.getByRole('radiogroup', { name: 'Effort' });
  await expect(effort.getByRole('radio')).toHaveText(['low', 'medium', 'highdefault', 'xhigh', 'max']);
  await expect(effort.getByRole('radio', { checked: true })).toHaveText('highdefault');
  await model.selectOption('claude-haiku-5-5');
  await effort.getByRole('radio', { name: 'low' }).click();
  await effort.getByRole('radio', { name: 'low' }).press('ArrowRight');
  await expect(effort.getByRole('radio', { name: /medium/ })).toBeFocused();
  await expect(effort.getByRole('radio', { checked: true })).toHaveText('mediumdefault');
  await student.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Settings saved.');

  await expect(student.getByLabel('Enter API key')).toHaveCount(0);                      // the input is gone; only the mask remains
  await expect(student.locator('.keybox')).toContainText('sk-ant-…WXYZ');
  await expect(page.locator('main')).not.toContainText(ANT);
  expect(await page.evaluate(() => localStorage.getItem('remath.mock.v1'))).not.toContain(ANT);
  await expect(tiles.nth(0)).toContainText('Anthropic · claude-haiku-5-5 · medium');
  await expect(tiles.nth(0)).toContainText('Ready');

  // the mentor shares the student's key: Anthropic models, custom model → the provider-wide effort set
  const mentor = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Mentor bot' }) });
  await expect(mentor.getByText('Sharing Student bot’s key')).toBeVisible();
  await mentor.getByLabel(/^Model/).selectOption({ label: 'Custom' });
  await mentor.getByLabel('Custom').fill('claude-next-6');
  await mentor.getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'xhigh' }).click();
  await mentor.getByRole('button', { name: 'Save' }).click();
  await expect(tiles.nth(1)).toContainText('Anthropic · claude-next-6 · xhigh');
});

test('scenario card "Chats CSV" downloads that scenario once it has a session', async ({ page }) => {
  const gabriel = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '가브리엘' }) });
  await expect(gabriel.getByRole('button', { name: 'Chats CSV (0)' })).toBeDisabled();
  await gabriel.getByRole('button', { name: 'Test chat' }).click();
  await expect(page.getByRole('log').locator('.msg.student')).toHaveCount(1);
  await page.goto('/admin/scenarios');
  const [download] = await Promise.all([page.waitForEvent('download'), gabriel.getByRole('button', { name: 'Chats CSV (1)' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^remath_scenario_gabriel_\d{8}\.csv$/);
});
