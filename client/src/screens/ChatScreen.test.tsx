// @vitest-environment jsdom
// #101: after a turn the message input gets focus back, unless the session is locked (ended / turn limit).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatScreen } from './ChatScreen.tsx';

const api = vi.hoisted(() => ({ getSession: vi.fn(), getCurrentSession: vi.fn(), startSession: vi.fn(), getPractice: vi.fn(), sendTurn: vi.fn(), endSession: vi.fn() }));
vi.mock('../apis.ts', () => ({ teacherApi: api, adminApi: api }));
vi.mock('../session.tsx', () => ({ useMe: () => ({ nickname: 'tester' }) }));

const AT = '2026-11-01T00:00:00.000Z';
const scenario = { id: 'sc1', lang: 'en', name: 'Mina', description: 'd', problem: 'p', student_prefix: '🙂', mentor_prefix: '🧑‍🏫', classification: { leverage: [], object: [] } };
const turn = (seq: number, speaker: 'teacher' | 'student' | 'mentor', text: string) => ({ seq, speaker, text, leverage: null, object: null, trigger: null, created_at: AT });
const detail = (turnCount: number, turnLimit: number, turns: ReturnType<typeof turn>[] = []) => ({
  session: { id: 's1', scenario_id: 'sc1', scenario_name: 'Mina', lang: 'en', user_id: 'u1', nickname: 'tester', started_at: AT, ended_at: null, goal_reached: false, turn_count: turnCount },
  turns, report: null, turn_limit: turnLimit,
});

/** A turn stream that waits for `open()` before yielding, so the test can observe the busy (disabled) state. */
function gated(events: object[]) {
  let open!: () => void;
  const gate = new Promise<void>(r => { open = r; });
  async function* stream() { await gate; yield* events; }
  return { stream: stream(), open };
}

const input = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLInputElement;

async function mount() {
  render(<MemoryRouter initialEntries={['/practice/sc1?session=s1']}><Routes><Route path="/practice/:id" element={<ChatScreen isAdminTest={false} />} /></Routes></MemoryRouter>);
  await screen.findByRole('textbox', { name: 'Message' });
}

/** Types and sends, then mimics the browser dropping focus from the input once it is disabled (jsdom keeps it, and blur() on a disabled input is a no-op). */
async function sendAndWaitBusy(text: string) {
  input().focus();
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.submit(input().form!);
  await waitFor(() => expect(input().disabled).toBe(true));
  const away = document.body.appendChild(document.createElement('button'));
  act(() => away.focus());
  expect(document.activeElement).not.toBe(input());
}

beforeEach(() => {
  globalThis.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
  Element.prototype.scrollTo = () => {};
  api.getSession.mockResolvedValue(detail(0, 10));
  api.getPractice.mockResolvedValue({ groups: [], scenarios: [scenario] });
});
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.clearAllMocks(); });

describe('ChatScreen composer focus (#101)', () => {
  it('focuses the input again when the turn completes', async () => {
    await mount();
    const g = gated([{ type: 'student', text: 'hi teacher', final: true }, { type: 'done', ended: false, turns: [turn(1, 'teacher', 'hello'), turn(2, 'student', 'hi teacher')] }]);
    api.sendTurn.mockReturnValue(g.stream);
    await sendAndWaitBusy('hello');
    await act(async () => g.open());
    await waitFor(() => expect(input().disabled).toBe(false));
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe('');
  });

  it('puts the text back and focuses the input when the turn fails', async () => {
    await mount();
    const g = gated([{ type: 'error', code: 'llm_failed', message: 'x', retryable: false }]);
    api.sendTurn.mockReturnValue(g.stream);
    await sendAndWaitBusy('hello');
    await act(async () => g.open());
    await waitFor(() => expect(input().disabled).toBe(false));
    expect(input().value).toBe('hello');
    expect(document.activeElement).toBe(input());
  });

  it('does not move focus when the turn limit is reached', async () => {
    api.getSession.mockResolvedValue(detail(0, 1));
    await mount();
    const g = gated([{ type: 'done', ended: false, turns: [turn(1, 'teacher', 'hello'), turn(2, 'student', 'bye')] }]);
    api.sendTurn.mockReturnValue(g.stream);
    await sendAndWaitBusy('hello');
    await act(async () => g.open());
    await screen.findByText(/^Turn limit \(1\) reached/);
    expect(input().disabled).toBe(true);
    expect(document.activeElement).not.toBe(input());
  });

  it('does not move focus when the session has ended', async () => {
    await mount();
    const g = gated([{ type: 'done', ended: true, report: null }]);
    api.sendTurn.mockReturnValue(g.stream);
    api.getSession.mockResolvedValue({ ...detail(1, 10), session: { ...detail(1, 10).session, ended_at: AT } });
    await sendAndWaitBusy('END SESSION');
    await act(async () => g.open());
    await screen.findByText(/^Session ended/);
    expect(input().disabled).toBe(true);
    expect(document.activeElement).not.toBe(input());
  });
});
