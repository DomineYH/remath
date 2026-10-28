// #26 · B-1: admin → /admin/scenarios/new → "Fill example" (Seoyeon) → 7 steps → review 7 PASS + 4 confirmations → publish
// → add user → group (member, scenario) → the teacher sees only that scenario; no group / no scenario notices on the way.
// Then Edit → Save draft takes it off the teacher screen (user story 52).
// The bot language is switched to English, so the new scenario ("Seoyeon") is told apart from the seeded Korean "서연".
import { expect, test, type Page } from '@playwright/test';
import seoyeon from '../db/seed/scenarios/seoyeon.json' with { type: 'json' };

const PW = 'abcd1234';
const STEPS = ['Student profile', 'Problem & solution', 'Misconceptions & rules', 'Mentor triggers', 'Classification', 'Safety review', 'Preview & publish'];

async function adminLogin(page: Page) {
  await page.goto('/admin');
  await page.getByLabel('Admin ID').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('E2eAdmin123');
  await page.getByRole('button', { name: 'Sign in as admin' }).click();
  await expect(page).toHaveURL('/admin/scenarios');
}
/** First call signs Bora in; later calls just open the practice home (both realms stay signed in side by side). */
let signedIn = false;
async function teacherHome(page: Page) {
  if (signedIn) { await page.goto('/practice'); return; }
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Bora');
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/practice');
  signedIn = true;
}

test('B-1: wizard → fill example → review → publish → user and group → the teacher sees only the new scenario', async ({ page }) => {
  test.slow();   // the longest journey in the suite: it neared the 30 s default under parallel workers
  await adminLogin(page);
  await page.getByRole('button', { name: '＋ New scenario' }).click();
  await expect(page).toHaveURL('/admin/scenarios/new');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('New scenario');
  const steps = page.getByRole('navigation', { name: 'Wizard steps' }).getByRole('button');
  await expect(steps).toHaveCount(7);
  await expect(steps.nth(0)).toHaveAttribute('aria-current', 'step');

  // empty form: step 7 cannot publish
  await steps.nth(6).click();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next →' })).toHaveCount(0);
  await steps.nth(0).click();

  // fill example = Seoyeon seed, both editions; chips only next to spine fields (none beside the mentor emoji)
  await page.getByRole('button', { name: 'Fill example (Seoyeon)' }).click();
  await expect(page.locator('#f-name')).toHaveValue('서연');
  await expect(page.locator('label[for="f-name"] .spine')).toHaveText('STUDENT_NAME');
  await expect(page.locator('label[for="f-prefix"] .spine')).toHaveText('STUDENT_PREFIX');
  await expect(page.locator('label[for="f-mprefix"] .spine')).toHaveCount(0);
  await expect(page.locator('label[for="f-greet"] .spine')).toHaveCount(0);

  // bot language → English: language fields swap, internal settings stay
  await page.getByRole('group', { name: 'Bot language' }).getByRole('button', { name: 'English' }).click();
  await expect(page.locator('#f-name')).toHaveValue('Seoyeon');
  await expect(page.locator('.notice.info')).toContainText('You are editing the English dialogue set');
  await expect(page.locator('.notice.info')).toContainText('The saved 한국어 set is kept as well.');

  // walk all seven steps with Next
  for (let i = 0; i < 6; i++) {
    await expect(steps.nth(i)).toHaveAttribute('aria-current', 'step');
    await expect(page.locator('.panel h3')).toHaveText(`${i + 1}. ${['Student profile', 'Problem & initial solution', 'Reasoning, misconceptions & progression', 'Mentor triggers', 'Classification criteria', 'Safety & quality review'][i]}`);
    if (i === 2) {
      await expect(page.locator('#f-goal')).toHaveValue(seoyeon.internal.goal);
      await expect(page.locator('.mis')).toHaveCount(3);
      await expect(page.locator('#m-kw-0')).toHaveValue(seoyeon.translations.en.misconceptions[0].kw);
    }
    if (i === 4) await expect(page.locator('.notice.ok')).toContainText('Classification on · 4 leverage / 9 object categories.');
    if (i < 5) await page.getByRole('button', { name: 'Next →' }).click();
  }
  for (const [i, name] of STEPS.entries()) await expect(steps.nth(i)).toHaveAccessibleName(name);

  // step 6: seven automatic checks pass, four confirmations
  await expect(page.getByRole('list', { name: 'Automatic checks' }).locator('.st')).toHaveText(Array(7).fill('PASS'));
  const manual = page.getByRole('group', { name: 'Admin confirmation' }).getByRole('checkbox');
  await expect(manual).toHaveCount(4);
  for (const c of await manual.all()) await c.check();
  await page.getByRole('button', { name: 'Next →' }).click();

  // step 7: publish notice + student → analysis → mentor prompts of the English edition
  await expect(steps.nth(6)).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('.notice.ok')).toHaveText('Review complete. Once published, it appears on the teacher screen.');
  await expect(page.locator('.prompt-part h4')).toHaveText(['Student', 'Analysis', 'Mentor']);
  await expect(page.locator('pre.prompt').first()).toContainText('Seoyeon');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page).toHaveURL('/admin/scenarios');
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Seoyeon' }) });
  await expect(card.locator('.pill').first()).toHaveText('Published');
  await expect(card).toContainText('English');
  await expect(card).toContainText('No group assigned');

  // add a user; the teacher has no group yet
  await page.getByRole('navigation', { name: 'Admin menu' }).getByRole('link', { name: 'Users' }).click();
  await page.getByRole('button', { name: '＋ Add user' }).click();
  const add = page.getByRole('dialog', { name: 'Add user' });
  await add.getByLabel('Nickname').fill('Bora');
  await add.getByLabel('Password', { exact: true }).fill(PW);
  await add.getByLabel('Confirm password').fill(PW);
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(add).toBeHidden();
  await teacherHome(page);
  await expect(page.getByText('Bora is not in any group')).toBeVisible();

  // group with Bora only → "no scenario"; then assign the new scenario → only it shows
  await page.goto('/admin/groups');
  await page.getByRole('button', { name: '＋ New group' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Group name').fill('B반');
  await dialog.getByRole('checkbox', { name: 'Bora' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await teacherHome(page);
  await expect(page.getByText("No scenarios are assigned to Bora's groups.")).toBeVisible();
  await page.goto('/admin/groups');
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'B반' }) }).getByRole('button', { name: 'Edit' }).click();
  await dialog.getByRole('checkbox', { name: '🐱 Seoyeon' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await teacherHome(page);
  const picks = page.locator('.pick button');
  await expect(picks).toHaveCount(1);
  await expect(picks).toContainText('Seoyeon');
  await expect(picks).toContainText('Group: B반');

  // Edit → the unpublish notice → Save draft: the card turns Draft and the teacher loses it
  await page.goto('/admin/scenarios');
  await card.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Edit scenario · Seoyeon');
  await expect(page.locator('.notice.warn').first()).toContainText('Saving a draft unpublishes it');
  await expect(page.locator('#f-name')).toHaveValue('Seoyeon');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL('/admin/scenarios');
  await expect(card.locator('.pill').first()).toHaveText('Draft');
  await teacherHome(page);
  await expect(page.getByText("No scenarios are assigned to Bora's groups.")).toBeVisible();
});
