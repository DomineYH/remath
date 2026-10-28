// #23: admin login → five sample cards → "View prompt" on Seoyeon opens the student, analysis and mentor prompts in full.
import { expect, test } from '@playwright/test';

test('scenario list cards and the prompt modal', async ({ page }) => {
  await page.goto('/admin');
  await page.getByLabel('Admin ID').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('E2eAdmin123');
  await page.getByRole('button', { name: 'Sign in as admin' }).click();
  await expect(page).toHaveURL('/admin/scenarios');

  await expect(page.getByText('Write scenario')).toBeVisible();   // WorkflowStrip
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(5);
  await expect(cards.getByRole('heading')).toHaveText(['가브리엘', 'Noah', '지우', '하준', '서연']);
  await expect(cards.getByText('No group assigned · nobody can use it')).toHaveCount(5);

  const seoyeon = cards.filter({ has: page.getByRole('heading', { name: '서연' }) });
  await expect(seoyeon).toContainText('5학년 · 소수 크기 비교');
  await expect(seoyeon).toContainText('0.7 m 리본과 0.65 m 리본이 있습니다. 어느 리본이 더 길까요?');
  for (const pill of ['Published', '한국어', '3 misconceptions', 'Classes 4·9']) await expect(seoyeon.getByText(pill, { exact: true })).toBeVisible();
  for (const name of ['Edit', 'Chats CSV (0)']) await expect(seoyeon.getByRole('button', { name })).toBeDisabled();
  await expect(seoyeon.getByRole('button', { name: 'Test chat' })).toBeEnabled();   // #24
  await expect(cards.filter({ has: page.getByRole('heading', { name: '하준' }) }).getByText('No classification', { exact: true })).toBeVisible();

  await seoyeon.getByRole('button', { name: 'View prompt' }).click();
  const dialog = page.getByRole('dialog', { name: 'Prompt · 서연' });
  await expect(dialog.getByRole('heading', { level: 4 })).toHaveText(['Student', 'Analysis', 'Mentor']);
  const pre = dialog.locator('pre');
  await expect(pre).toHaveCount(3);
  await expect(pre.nth(0)).toContainText('"0.7 m 리본과 0.65 m 리본이 있습니다. 어느 리본이 더 길까요?"');
  await expect(pre.nth(1)).toContainText('[CLASSIFICATION]');
  await expect(pre.nth(2)).toContainText('"0을 붙여라"는 규칙은 서연이가 이해 없이 외우게 해요.');
  for (const p of await pre.allTextContents()) expect(p).not.toContain('{{');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  // no classification → the analysis slot says it is not compiled
  await cards.filter({ has: page.getByRole('heading', { name: '하준' }) }).getByRole('button', { name: 'View prompt' }).click();
  const hajun = page.getByRole('dialog', { name: 'Prompt · 하준' });
  await expect(hajun.locator('pre')).toHaveCount(2);
  await expect(hajun.getByText('Not compiled (no classification criteria)')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hajun).toBeHidden();
});
