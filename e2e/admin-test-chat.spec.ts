// #24 · B-3: the admin test chat. The internal-state panel updates every turn; Gabriel reaches the goal → report;
// a reload keeps the ended session; a reloaded live session is recovered and ends with END SESSION.
import { expect, test, type Page } from '@playwright/test';

const GREET = '안녕하세요… 저는 가브리엘이에요.';
const MIS = ['하나의 분수로 합칠 필요성을 느끼지 못함', '2/4와 4/8이 같은 양임을 모름(조각 크기 비교)', '같은 크기 조각을 세어 합하는 절차를 모름'];
const T3 = '좋은 발문이었어요. 가브리엘이 자기 그림을 바탕으로 2/4 = 4/8에 스스로 도달했네요.';
const L1 = ['한 친구가 받는 걸 모두 합치면 얼마야?', '그러면 한 사람이 받는 게 전부 얼마인지 하나로 말해 볼래?', '4분의 1 조각을 반으로 자르면 어떻게 될까?', '그 조각을 더 작게 자르면 8분의 1이 몇 개야?', '8분의 1 조각이 다 해서 몇 개야?', '모두 몇 조각인지 세어 볼래?'];

async function openGabrielTest(page: Page) {
  await page.goto('/admin/scenarios');
  const gabriel = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '가브리엘' }) });
  await gabriel.getByRole('button', { name: 'Test chat' }).click();
  await expect(page).toHaveURL(/\/admin\/scenarios\/[0-9a-f-]+\/test\?session=[0-9a-f-]+$/);
}

test('admin test chat: panel per turn, goal → report, reload keeps it, recovered session ends with END SESSION', async ({ page }) => {
  await page.goto('/admin');
  await page.getByLabel('Admin ID').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('E2eAdmin123');
  await page.getByRole('button', { name: 'Sign in as admin' }).click();
  await expect(page).toHaveURL('/admin/scenarios');
  await openGabrielTest(page);

  const log = page.getByRole('log'), students = log.locator('.msg.student');
  const panel = page.getByRole('complementary', { name: 'Internal state' }), track = panel.getByRole('listitem');
  const input = page.getByRole('textbox', { name: 'Message' }), send = page.getByRole('button', { name: 'Send' });
  const lastTrigger = panel.getByRole('region', { name: 'Last mentor trigger' });
  await expect(page.getByText('8명의 친구들이 5개의 팝타르트를 똑같이 나누어 먹으려고 합니다.', { exact: false })).toBeVisible();   // ProblemBox
  await expect(students.first()).toContainText(GREET);
  await expect(panel).toContainText('Internal state for admin test chats');
  await expect(track).toHaveText(MIS.map(m => `0/2${m}`));
  await expect(lastTrigger).toContainText('None yet');

  // quick chips fill the composer (chat-language chips: Gabriel is ko)
  await page.getByRole('button', { name: '안녕, 네 이름이 뭐야?' }).click();
  await expect(input).toHaveValue('안녕, 네 이름이 뭐야?');
  await send.click();
  await expect(students).toHaveCount(2);
  await page.getByRole('button', { name: '어떻게 풀었는지 말해 줄래?' }).click();
  await send.click();
  await expect(students).toHaveCount(3);
  await expect(panel.getByRole('region', { name: 'Leverage tally' })).toContainText(/Eliciting\s*1/);

  // classification blocks are hidden until the toggle is on
  const blocks = log.getByText('[CLASSIFICATION]');
  await expect(blocks.first()).toBeHidden();
  await page.getByLabel('Show [CLASSIFICATION] blocks').check();
  await expect(blocks).toHaveCount(2);
  await expect(blocks.first()).toBeVisible();
  await page.getByLabel('Show [CLASSIFICATION] blocks').uncheck();
  await expect(blocks.first()).toBeHidden();

  // the rest of L1, one turn at a time: misconception dots move 0/2 → 1/2 → ✓
  const dots = ['1/2', '✓', '1/2', '✓', '1/2', '✓'];
  for (const [i, q] of L1.entries()) {
    await input.fill(q);
    await input.press('Enter');
    await expect(students).toHaveCount(4 + i);
    await expect(track.nth(Math.floor(i / 2))).toHaveText(dots[i] + MIS[Math.floor(i / 2)]);
  }
  await expect(log.locator('.msg.mentor')).toContainText(T3);
  await expect(lastTrigger).toContainText('Trigger 3 · Goal reached');

  // end → report (bars, lists, verdict + reach sentence; no goal or misconception text)
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  const report = page.getByRole('region', { name: 'Session analysis · question types' });
  await expect(report).toContainText('8 turns');
  await expect(report).toContainText('학생이 스스로 결론을 수정하는 지점까지 도달했습니다.');
  await expect(report.getByRole('listitem')).toHaveCount(8);
  for (const m of MIS) await expect(report).not.toContainText(m);
  await expect(input).toBeDisabled();

  // reload keeps the ended session
  await page.reload();
  await expect(report).toContainText('8 turns');
  await expect(input).toBeDisabled();
  await expect(lastTrigger).toContainText('Trigger 3 · Goal reached');

  // a new test session; reload mid-session recovers it; END SESSION typed into the composer ends it
  await page.getByRole('button', { name: 'Other students' }).click();
  await expect(page).toHaveURL('/admin/scenarios');
  await openGabrielTest(page);
  await page.getByRole('button', { name: '도와줘' }).click();
  await send.click();
  await expect(students).toHaveCount(2);
  await expect(lastTrigger).toContainText('Trigger 2 · User asked for help');
  await page.reload();
  await expect(students).toHaveCount(2);
  await expect(lastTrigger).toContainText('Trigger 2 · User asked for help');
  await expect(input).toBeEnabled();
  await input.fill('END SESSION');
  await send.click();
  await expect(report).toContainText('1 turn');   // "도와줘" is classified (Other) and counted
  await expect(page.getByText('Session ended · leverage analysis only')).toBeVisible();
  await expect(input).toBeDisabled();
});

test('I-51: a stream that drops after the turn was recorded keeps it; one that drops before restores the input', async ({ page }) => {
  await page.goto('/admin');
  await page.getByLabel('Admin ID').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('E2eAdmin123');
  await page.getByRole('button', { name: 'Sign in as admin' }).click();
  await openGabrielTest(page);
  const log = page.getByRole('log'), input = page.getByRole('textbox', { name: 'Message' });
  const failed = page.getByText('No response was received.', { exact: false });

  await page.evaluate(() => { (globalThis as { __remathMockDrop?: string }).__remathMockDrop = 'after'; });
  await input.fill('어떻게 풀었는지 말해 줄래?');
  await input.press('Enter');
  await expect(log.locator('.msg.student')).toHaveCount(2);
  await expect(log.locator('.msg.me')).toHaveCount(1);
  await expect(input).toHaveValue('');
  await expect(failed).toBeHidden();

  await page.evaluate(() => { (globalThis as { __remathMockDrop?: string }).__remathMockDrop = 'before'; });
  await input.fill('왜 그렇게 생각했어?');
  await input.press('Enter');
  await expect(failed).toBeVisible();
  await expect(input).toHaveValue('왜 그렇게 생각했어?');
  await expect(log.locator('.msg.me')).toHaveCount(1);
});
