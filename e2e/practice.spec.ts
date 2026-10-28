// #25 · B-1 (no group → no scenario → visible), B-2 (account → chat → report → My history shows the same report),
// B-3 (no internal panel DOM on the teacher chat). Both realms are signed in side by side in one browser (separate cookies).
import { expect, test, type Page } from '@playwright/test';

const PW = 'abcd1234';
const MIS = ['하나의 분수로 합칠 필요성을 느끼지 못함', '2/4와 4/8이 같은 양임을 모름(조각 크기 비교)', '같은 크기 조각을 세어 합하는 절차를 모름'];
const T3 = '좋은 발문이었어요. 가브리엘이 자기 그림을 바탕으로 2/4 = 4/8에 스스로 도달했네요.';
const L1 = ['한 친구가 받는 걸 모두 합치면 얼마야?', '그러면 한 사람이 받는 게 전부 얼마인지 하나로 말해 볼래?', '4분의 1 조각을 반으로 자르면 어떻게 될까?', '그 조각을 더 작게 자르면 8분의 1이 몇 개야?', '8분의 1 조각이 다 해서 몇 개야?', '모두 몇 조각인지 세어 볼래?'];

async function adminLogin(page: Page) {
  await page.goto('/admin');
  await page.getByLabel('Admin ID').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('E2eAdmin123');
  await page.getByRole('button', { name: 'Sign in as admin' }).click();
  await expect(page).toHaveURL('/admin/scenarios');
}

/** Groups tab → new group or edit, then tick members and scenarios by their visible label. */
async function saveGroup(page: Page, name: string, ticks: string[], edit = false) {
  await page.goto('/admin/groups');
  if (edit) await page.getByRole('article').filter({ has: page.getByRole('heading', { name }) }).getByRole('button', { name: 'Edit' }).click();
  else await page.getByRole('button', { name: '＋ New group' }).click();
  const dialog = page.getByRole('dialog');
  if (!edit) await dialog.getByLabel('Group name').fill(name);
  for (const label of ticks) await dialog.getByRole('checkbox', { name: label }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

test('B-1: admin adds a user; the teacher sees no group → no scenario → only the assigned published scenario', async ({ page }) => {
  await adminLogin(page);
  await page.getByRole('navigation', { name: 'Admin menu' }).getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('table', { name: 'Users' })).toContainText('No users yet.');

  // AddUserModal: nickname · live password rules · group checklist (none yet)
  await page.getByRole('button', { name: '＋ Add user' }).click();
  const add = page.getByRole('dialog', { name: 'Add user' });
  await expect(add).toContainText('No groups yet.');
  await add.getByLabel('Nickname').fill('Bora');
  await add.getByLabel('Password', { exact: true }).fill('abcd');
  await expect(add.locator('.pwrules li').nth(0)).toHaveClass('no');
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(add.getByRole('alert')).toHaveText('Passwords need 8+ characters with both letters and numbers, and no spaces.');
  await add.getByLabel('Password', { exact: true }).fill(PW);
  await add.getByLabel('Confirm password').fill(PW);
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(add).toBeHidden();
  const row = page.getByRole('row').filter({ hasText: 'Bora' });
  await expect(row).toContainText('No group');
  await expect(row).toContainText('No access');

  // the teacher signs in: no group
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Bora');
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/practice');
  await expect(page.getByText('Bora is not in any group')).toBeVisible();

  // a group with Bora but no scenario: the card warns, the teacher gets the other notice
  await saveGroup(page, 'B반', ['Bora']);
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'B반' }) });
  await expect(card).toContainText('1 member');
  await expect(card).toContainText('No scenarios assigned · no access');
  await page.goto('/practice');
  await expect(page.getByText("No scenarios are assigned to Bora's groups.")).toBeVisible();
  await expect(page.getByText('Bora is not in any group')).toHaveCount(0);

  // assign Seoyeon → only Seoyeon shows, through B반
  await saveGroup(page, 'B반', ['🐱 서연'], true);
  await expect(card.locator('.pill.lang')).toHaveText(['서연']);
  await page.goto('/practice');
  const picks = page.locator('.pick button');
  await expect(picks).toHaveCount(1);
  await expect(picks).toContainText('서연');
  await expect(picks).toContainText('Group: B반');
  await expect(picks).toContainText('Question analysis at the end');
  await expect(page.locator('.notice')).toHaveCount(0);

  // admin: the row now shows the group; a password reset signs the teacher out; delete removes the row
  await page.goto('/admin/users');
  await expect(row).toContainText('B반');
  await expect(row).toContainText('1 scenario');
  await row.getByRole('button', { name: 'Password · Bora' }).click();
  const pw = page.getByRole('dialog', { name: 'Change password · Bora' });
  await pw.getByLabel('Password', { exact: true }).fill('efgh5678');
  await pw.getByLabel('Confirm password').fill('efgh5678');
  await pw.getByRole('button', { name: 'Save' }).click();
  await expect(pw).toBeHidden();
  await page.goto('/practice');
  await expect(page).toHaveURL('/');
  await page.goto('/admin/users');
  await row.getByRole('button', { name: 'Delete · Bora' }).click();
  const del = page.getByRole('dialog', { name: 'Delete user Bora' });
  await expect(del).toContainText('This also deletes 0 conversation records');
  await expect(del.getByRole('button', { name: 'Download CSV first' })).toHaveCount(0);
  await del.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('table', { name: 'Users' })).toContainText('No users yet.');
});

test('B-2/B-3: create account → chat → goal → end → report; reload keeps it; My history shows the same report; no panel DOM', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Nickname').fill('a@b');
  await expect(page.getByRole('alert')).toContainText('look like an email or phone number');
  await page.getByLabel('Nickname').fill('Haneul');
  const rules = page.locator('.pwrules li');
  await page.getByLabel('Password', { exact: true }).fill('abcdefgh');
  await expect(rules.nth(0)).toHaveClass('ok');
  await expect(rules.nth(1)).toHaveClass('no');
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await expect(rules.nth(1)).toHaveClass('ok');
  await page.getByLabel('Confirm password').fill(PW);
  await page.getByRole('button', { name: 'Create account and start' }).click();
  await expect(page).toHaveURL('/practice');

  await adminLogin(page);
  await saveGroup(page, 'A반', ['Haneul', '🦊 가브리엘', '🐼 하준']);
  await page.goto('/practice');
  await expect(page.locator('.pick button')).toHaveCount(2);
  await page.locator('.pick button').filter({ hasText: '가브리엘' }).click();
  await expect(page).toHaveURL(/\/practice\/[0-9a-f-]+\?session=[0-9a-f-]+$/);
  const chatUrl = page.url();

  const log = page.getByRole('log'), students = log.locator('.msg.student');
  const input = page.getByRole('textbox', { name: 'Message' }), send = page.getByRole('button', { name: 'Send' });
  await expect(students.first()).toContainText('안녕하세요… 저는 가브리엘이에요.');
  // B-3: the teacher chat has no internal-state panel in the DOM at all
  await expect(page.locator('.rail, .rail-d, aside')).toHaveCount(0);
  await expect(page.getByText('Internal state')).toHaveCount(0);

  await page.getByRole('button', { name: '안녕, 네 이름이 뭐야?' }).click();
  await expect(input).toHaveValue('안녕, 네 이름이 뭐야?');
  await send.click();
  await expect(students).toHaveCount(2);
  const blocks = log.getByText('[CLASSIFICATION]');
  await expect(blocks.first()).toBeHidden();
  await page.getByLabel('Show [CLASSIFICATION] blocks').check();
  await expect(blocks.first()).toBeVisible();
  await page.getByLabel('Show [CLASSIFICATION] blocks').uncheck();
  await expect(blocks.first()).toBeHidden();

  // picking another student mid-session: end-first notice, then back to the session in progress
  await page.getByRole('button', { name: 'Other students' }).click();
  await expect(page).toHaveURL('/practice');
  await page.locator('.pick button').filter({ hasText: '하준' }).click();
  await expect(page.getByText('A practice session is already in progress.')).toBeVisible();
  await page.getByRole('button', { name: 'Go to the session in progress' }).click();
  await expect(students).toHaveCount(2);
  await expect(page.locator('.chat-h')).toContainText('가브리엘');

  await page.getByRole('button', { name: '어떻게 풀었는지 말해 줄래?' }).click();
  await send.click();
  await expect(students).toHaveCount(3);
  for (const [i, q] of L1.entries()) {
    await input.fill(q);
    await input.press('Enter');
    await expect(students).toHaveCount(4 + i);
  }
  await expect(log.locator('.msg.mentor')).toContainText(T3);
  await expect(page.locator('.rail, .rail-d, aside')).toHaveCount(0);

  await page.getByRole('button', { name: 'End session', exact: true }).click();
  const report = page.getByRole('region', { name: 'Session analysis · question types' });
  await expect(report).toContainText('8 turns');
  await expect(report).toContainText('학생이 스스로 결론을 수정하는 지점까지 도달했습니다.');
  await expect(report.getByRole('listitem')).toHaveCount(8);
  for (const m of MIS) await expect(page.locator('main')).not.toContainText(m);
  const shown = await report.innerText();

  await page.reload();
  await expect(report).toContainText('8 turns');
  await expect(input).toBeDisabled();
  expect(page.url()).toBe(chatUrl);

  // My history → View: the same report, the whole conversation with leverage tags
  await page.getByRole('button', { name: 'Other students' }).click();
  await page.getByRole('link', { name: 'My history →' }).click();
  await expect(page).toHaveURL('/practice/history');
  const rows = page.getByRole('table', { name: 'My history' }).getByRole('row');
  await expect(rows).toHaveCount(2);   // header + one session
  await expect(rows.nth(1)).toContainText('가브리엘');
  await expect(rows.nth(1)).toContainText('Reached');
  await expect(rows.nth(1)).toContainText('8');
  await rows.nth(1).getByRole('button', { name: /^View/ }).click();
  const dialog = page.getByRole('dialog', { name: '가브리엘' });
  await expect(dialog.locator('.tx .ln')).toHaveCount(18);
  await expect(dialog.locator('.tx .ln.teacher').first()).toContainText('[Other');
  expect(await dialog.getByRole('region', { name: 'Session analysis · question types' }).innerText()).toBe(shown);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
