// #28 · B-4: at 400×800 every screen fits the viewport (no document-level horizontal scroll) with a one-line top bar;
// the ⋯ menu, the account dropdown and the panel <details> open and close by keyboard; dark mode flips data-theme;
// EN↔한 changes the interface copy but not the chatbot lines.
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 400, height: 800 } });

const PW = 'abcd1234';
const GREET = '안녕하세요… 저는 가브리엘이에요.';

/** No document-level horizontal scroll (I-54), the top bar on one line (ticket 17 #3: all bar items share one centre line)
 *  a label on every form control (I-55) and no mockup-only demo element (I-41). */
async function fits(page: Page, where: string) {
  await expect(page.locator('.top')).toBeVisible();
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    mids: [...document.querySelectorAll('.top .in > *')].map(e => e.getBoundingClientRect()).filter(r => r.height > 0).map(r => r.top + r.height / 2),
    demo: /\bdemo\b|데모/i.test(document.body.innerText),
    unlabelled: [...document.querySelectorAll<HTMLInputElement>('input, select, textarea')]
      .filter(e => !e.labels?.length && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby')).map(e => e.outerHTML.slice(0, 80)),
  }));
  expect(m.sw, `${where}: scrollWidth`).toBeLessThanOrEqual(400);
  expect(Math.max(...m.mids) - Math.min(...m.mids), `${where}: top bar on one line`).toBeLessThan(4);
  expect(m.demo, `${where}: mockup-only demo element (I-41)`).toBe(false);
  expect(m.unlabelled, `${where}: form controls without a label`).toEqual([]);
}

/** A menu button: Enter opens it (aria-expanded), Esc closes it and returns focus, an outside click closes it too. */
async function menuByKeyboard(page: Page, button: ReturnType<Page['getByRole']>) {
  const menu = page.getByRole('menu');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();
  await page.keyboard.press('Space');
  await expect(menu).toBeVisible();
  await page.mouse.click(200, 700);
  await expect(menu).toHaveCount(0);
}

async function saveGroup(page: Page, name: string, ticks: string[]) {
  await page.getByRole('button', { name: '＋ New group' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Group name').fill(name);
  for (const label of ticks) await dialog.getByRole('checkbox', { name: label }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

test('B-4: 400px smoke over every screen, menus by keyboard, dark mode, EN↔한', async ({ page }) => {
  test.slow();
  // teacher sign-in and create-account tabs
  await page.goto('/');
  await fits(page, 'login');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await fits(page, 'signup');

  // admin login → scenarios: the workflow strip is hidden, the account dropdown works by keyboard
  await page.goto('/admin');
  await fits(page, 'admin login');
  await page.getByLabel('Admin ID').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('E2eAdmin123');
  await page.getByRole('button', { name: 'Sign in as admin' }).click();
  await expect(page).toHaveURL('/admin/scenarios');
  await expect(page.getByRole('article')).toHaveCount(5);
  await fits(page, 'scenarios');
  await expect(page.locator('.flow')).toBeHidden();
  await menuByKeyboard(page, page.getByRole('button', { name: 'Account menu' }));

  // wizard: number circles only (each with an aria-label), every step fits; step 5 rows keep their placeholders
  await page.getByRole('button', { name: '＋ New scenario' }).click();
  await page.getByRole('button', { name: 'Fill example (Seoyeon)' }).click();
  const steps = page.locator('.steps button');
  await expect(steps).toHaveCount(7);
  for (let i = 0; i < 7; i++) {
    await expect(steps.nth(i).locator('.lbl')).toBeHidden();
    await expect(steps.nth(i)).toHaveAttribute('aria-label', /\S/);
    await steps.nth(i).click();
    await expect(steps.nth(i)).toHaveAttribute('aria-current', 'step');
    await fits(page, `wizard step ${i + 1}`);
  }
  await steps.nth(4).click();
  const row = page.locator('.clsrow:not(.head)').first();
  for (const input of await row.locator('input, textarea').all()) await expect(input).toHaveAttribute('placeholder', /\S/);

  // users and groups: a teacher in a group with Gabriel
  // modal focus rules (I-55): first input focused, Esc closes and restores focus to the opener
  await page.goto('/admin/users');
  const opener = page.getByRole('button', { name: '＋ Add user' });
  const add = page.getByRole('dialog', { name: 'Add user' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(add.getByLabel('Nickname')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(add).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await add.getByLabel('Nickname').fill('Bora');
  await add.getByLabel('Password', { exact: true }).fill(PW);
  await add.getByLabel('Confirm password').fill(PW);
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(add).toBeHidden();
  await fits(page, 'users');
  await page.goto('/admin/groups');
  await saveGroup(page, 'A반', ['Bora', '🦊 가브리엘']);
  await fits(page, 'groups');

  // admin test chat: the panel is a closed <details> above the chat; it and the ⋯ menu work by keyboard
  await page.goto('/admin/scenarios');
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: '가브리엘' }) }).getByRole('button', { name: 'Test chat' }).click();
  await expect(page.getByRole('log').locator('.msg.student').first()).toContainText(GREET);
  await fits(page, 'admin test chat');
  const details = page.locator('details.rail-d');
  await expect(details).not.toHaveAttribute('open');
  expect(await details.evaluate(d => !!(d.compareDocumentPosition(document.querySelector('.chat')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await details.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open');
  await expect(page.getByRole('complementary', { name: 'Internal state' })).toBeVisible();
  await fits(page, 'admin test chat, panel open');
  await page.keyboard.press('Enter');
  await expect(details).not.toHaveAttribute('open');
  await expect(page.locator('.chat-h .tools')).toBeHidden();
  await menuByKeyboard(page, page.getByRole('button', { name: 'Chat tools' }));
  await page.getByRole('button', { name: 'Chat tools' }).click();
  await page.getByRole('menuitem', { name: 'End session' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeDisabled();

  await page.goto('/admin/logs');
  await expect(page.getByRole('table')).toContainText('가브리엘');
  await fits(page, 'logs');
  await page.goto('/admin/ai');
  await fits(page, 'ai settings');

  // teacher: practice home → chat → history
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Bora');
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/practice');
  await fits(page, 'practice home');
  await expect(page.locator('.band')).toHaveCSS('padding', '24px');
  await page.locator('.pick button').filter({ hasText: '가브리엘' }).click();
  const students = page.getByRole('log').locator('.msg.student');
  await expect(students.first()).toContainText(GREET);
  await fits(page, 'teacher chat');
  await menuByKeyboard(page, page.getByRole('button', { name: 'Chat tools' }));
  await page.getByRole('button', { name: '안녕, 네 이름이 뭐야?' }).click();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(students).toHaveCount(2);
  const lines = await page.getByRole('log').locator('.bub').allTextContents();

  // EN → 한: interface copy changes, chatbot lines stay; then back
  const ui = page.getByRole('group', { name: 'Interface language' });
  await ui.getByRole('button', { name: '한' }).click();
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible();
  await expect(page.getByRole('log').locator('.bub')).toHaveText(lines);
  await fits(page, 'teacher chat (ko)');
  await page.getByRole('group', { name: '화면 언어' }).getByRole('button', { name: 'EN' }).click();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.getByRole('log').locator('.bub')).toHaveText(lines);

  // dark mode flips data-theme
  const html = page.locator('html');
  const dark = (await html.getAttribute('data-theme')) === 'dark' || await page.evaluate(() => !document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  await page.getByRole('banner').getByRole('button', { name: dark ? 'Light mode' : 'Dark mode' }).click();
  await expect(html).toHaveAttribute('data-theme', dark ? 'light' : 'dark');
  await fits(page, 'teacher chat (theme flipped)');

  await page.getByRole('button', { name: 'Chat tools' }).click();
  await page.getByRole('menuitem', { name: 'End session' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  await page.goto('/practice/history');
  await expect(page.getByRole('table')).toContainText('가브리엘');
  await fits(page, 'history');
  expect(await page.locator('table.tbl').evaluate(t => getComputedStyle(t).minWidth)).not.toBe('860px');
});
