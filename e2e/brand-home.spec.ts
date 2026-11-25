// #108: the top-bar brand links to the user's home: teacher → /practice, admin (incl. the admin test chat) → /admin/scenarios,
// logged out → the login screen it is on. Plain navigation from a live chat (no dialog, no modal), a named link that is
// reached by Tab with the shared focus ring, and the same look as the old <div>.
import { expect, test, type Page } from '@playwright/test';

const PW = 'abcd1234';
const brand = (page: Page, name = 'PReMTA home') => page.getByRole('banner').getByRole('link', { name, exact: true });

async function adminLogin(page: Page) {
  await page.goto('/admin');
  await page.getByLabel('Admin ID').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('E2eAdmin123');
  await page.getByRole('button', { name: 'Sign in as admin' }).click();
  await expect(page).toHaveURL('/admin/scenarios');
}

async function signUp(page: Page, nick: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Nickname').fill(nick);
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.getByLabel('Confirm password').fill(PW);
  await page.getByRole('button', { name: 'Create account and start' }).click();
  await expect(page).toHaveURL('/practice');
}

/** Records every native dialog (and dismisses it) so a test can require that none appeared. */
function recordDialogs(page: Page) {
  const seen: string[] = [];
  page.on('dialog', d => { seen.push(d.type()); void d.dismiss(); });
  return seen;
}

/** One turn in a live chat: send a quick chip, wait for the student's reply and the composer to be usable again. */
async function oneTurn(page: Page) {
  const students = page.getByRole('log').locator('.msg.student');
  await expect(students.first()).toContainText('안녕하세요… 저는 가브리엘이에요.');
  await page.getByRole('button', { name: '안녕, 네 이름이 뭐야?' }).click();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(students).toHaveCount(2);
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeEnabled();
}

test('logged out: the brand links to the login screen it is on', async ({ page }) => {
  await page.goto('/');
  await expect(brand(page)).toHaveAttribute('href', '/');
  await brand(page).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByLabel('Nickname')).toBeVisible();

  await page.goto('/admin');
  await expect(brand(page)).toHaveAttribute('href', '/admin');
  await brand(page).click();
  await expect(page).toHaveURL('/admin');
  await expect(page.getByLabel('Admin ID')).toBeVisible();
});

test('teacher: the brand goes to /practice from history and from a live chat, with no dialog or modal', async ({ page }) => {
  await signUp(page, 'Brandt');
  await page.goto('/practice/history');
  await expect(brand(page)).toHaveAttribute('href', '/practice');
  await brand(page).click();
  await expect(page).toHaveURL('/practice');
  await expect(page.getByText('Brandt is not in any group')).toBeVisible();

  // give the teacher Gabriel, start a chat and take one turn
  await adminLogin(page);
  await page.goto('/admin/groups');
  await page.getByRole('button', { name: '＋ New group' }).click();
  const group = page.getByRole('dialog');
  await group.getByLabel('Group name').fill('A반');
  for (const label of ['Brandt', '🦊 가브리엘']) await group.getByRole('checkbox', { name: label }).check();
  await group.getByRole('button', { name: 'Save' }).click();
  await expect(group).toBeHidden();
  await page.goto('/practice');
  await page.locator('.pick button').filter({ hasText: '가브리엘' }).click();
  await expect(page).toHaveURL(/\/practice\/[0-9a-f-]+\?session=[0-9a-f-]+$/);
  await oneTurn(page);

  const dialogs = recordDialogs(page);
  await expect(brand(page)).toHaveAttribute('href', '/practice');
  await brand(page).click();
  await expect(page).toHaveURL('/practice');   // exact: the ?session= query is gone
  await expect(page.locator('.pick button')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('admin: the brand goes to /admin/scenarios from every admin screen and from a live test chat', async ({ page }) => {
  await adminLogin(page);
  for (const path of ['/admin/scenarios/new', '/admin/users', '/admin/groups', '/admin/logs', '/admin/ai']) {
    await page.goto(path);
    await expect(brand(page), path).toHaveAttribute('href', '/admin/scenarios');
  }
  await page.goto('/admin/users');
  await brand(page).click();
  await expect(page).toHaveURL('/admin/scenarios');
  await expect(page.getByRole('article')).toHaveCount(5);

  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: '가브리엘' }) }).getByRole('button', { name: 'Test chat' }).click();
  await expect(page).toHaveURL(/\/admin\/scenarios\/[0-9a-f-]+\/test\?session=[0-9a-f-]+$/);
  await oneTurn(page);

  const dialogs = recordDialogs(page);
  await expect(brand(page)).toHaveAttribute('href', '/admin/scenarios');
  await brand(page).click();
  await expect(page).toHaveURL('/admin/scenarios');
  await expect(page.getByRole('article')).toHaveCount(5);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

/** Fresh load, Tab from the document: the brand takes focus with the shared 2px/1px ring, the next Tab reaches `next`,
 *  Shift+Tab comes back. */
async function tabOrder(page: Page, path: string, next: ReturnType<Page['getByRole']>) {
  await page.goto(path);
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(brand(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(brand(page)).toBeFocused();
  const ring = await brand(page).evaluate(e => {
    const cs = getComputedStyle(e);
    return { visible: e.matches(':focus-visible'), outline: `${cs.outlineWidth} ${cs.outlineStyle}`, offset: cs.outlineOffset };
  });
  expect(ring).toEqual({ visible: true, outline: '2px solid', offset: '1px' });
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(brand(page)).toBeFocused();
}

test('keyboard and name: one named link per locale, Tab order with the focus ring, Enter goes home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner').getByRole('link')).toHaveCount(1);
  await expect(brand(page)).toHaveCount(1);
  await page.getByRole('group', { name: 'Interface language' }).getByRole('button', { name: '한' }).click();
  await expect(brand(page, 'PReMTA 홈')).toHaveCount(1);
  await expect(page.getByRole('banner').getByRole('link')).toHaveCount(1);
  await page.getByRole('group', { name: '화면 언어' }).getByRole('button', { name: 'EN' }).click();
  await expect(brand(page)).toHaveCount(1);

  // label in name (WCAG 2.5.3): the visible brand text is PReMTA in both locales, and each accessible name contains it
  for (const [lang, name] of [['EN', 'PReMTA home'], ['한', 'PReMTA 홈']] as const) {
    await page.getByRole('banner').getByRole('group').getByRole('button', { name: lang }).click();
    await expect(brand(page, name).locator('> b')).toHaveText('PReMTA', { useInnerText: true });
    expect(name).toContain('PReMTA');
  }
  await page.getByRole('banner').getByRole('group').getByRole('button', { name: 'EN' }).click();
  await expect(brand(page)).toHaveCount(1);

  // signed out: brand → 한
  await tabOrder(page, '/', page.getByRole('group', { name: 'Interface language' }).getByRole('button', { name: '한' }));

  // signed in (admin): brand → account button; Enter on a protected non-home screen goes home
  await adminLogin(page);
  await tabOrder(page, '/admin/logs', page.getByRole('button', { name: 'Account menu' }));
  await expect(brand(page)).toHaveAttribute('href', '/admin/scenarios');   // /admin would also redirect there: pin the link
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/admin/scenarios');
  await expect(page.getByRole('article')).toHaveCount(5);
});

test('the brand looks unchanged in light and dark: parent colour, no underline at rest or on hover', async ({ page }) => {
  await page.goto('/');
  const look = () => brand(page).evaluate(e => ({
    color: getComputedStyle(e).color, parent: getComputedStyle(e.parentElement!).color, decoration: getComputedStyle(e).textDecorationLine,
  }));
  const html = page.locator('html');
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(0, 400);
    const rest = await look();
    expect(rest.color).toBe(rest.parent);
    expect(rest.decoration).toBe('none');
    await brand(page).hover();
    const hover = await look();
    expect(hover.color).toBe(hover.parent);
    expect(hover.decoration).toBe('none');
    // flip the theme for the second pass
    const theme = await html.getAttribute('data-theme') ?? (await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light');
    if (i === 0) {
      await page.getByRole('banner').getByRole('button', { name: theme === 'dark' ? 'Light mode' : 'Dark mode' }).click();
      await expect(html).toHaveAttribute('data-theme', theme === 'dark' ? 'light' : 'dark');
    }
  }
});
