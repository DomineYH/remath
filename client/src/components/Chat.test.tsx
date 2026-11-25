// @vitest-environment jsdom
// #102: TurnLog keeps the newest content in view, whatever changed inside it.
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnLog } from './Chat.tsx';

// jsdom has no layout: scrollHeight is a stub, and every scrollTop write is recorded.
let height = 0, writes: number[] = [];
const last = () => writes.at(-1);

beforeEach(() => {
  height = 100; writes = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true, get: () => writes.at(-1) ?? 0, set: (v: number) => { writes.push(v); } });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop');
  vi.restoreAllMocks();
});

const lines = (texts: string[], hide = false) => texts.map((s, i) => <div key={i} className="msg" hidden={hide && i === 0}>{s}</div>);

describe('TurnLog scroll (#102)', () => {
  it('starts at the bottom on mount', () => {
    height = 500;
    render(<TurnLog>{lines(['a', 'b'])}</TurnLog>);
    expect(last()).toBe(500);
  });

  it('scrolls to the bottom when a line is appended', async () => {
    const { rerender } = render(<TurnLog>{lines(['a'])}</TurnLog>);
    height = 800;
    rerender(<TurnLog>{lines(['a', 'b'])}</TurnLog>);
    await waitFor(() => expect(last()).toBe(800));
  });

  it('scrolls to the bottom when an existing line changes text', async () => {
    const { rerender } = render(<TurnLog>{lines(['a', 'b'])}</TurnLog>);
    height = 900;
    rerender(<TurnLog>{lines(['a', 'b grows longer'])}</TurnLog>);
    await waitFor(() => expect(last()).toBe(900));
  });

  it('scrolls to the bottom when hidden content is shown', async () => {
    const { rerender } = render(<TurnLog>{lines(['a', 'b'], true)}</TurnLog>);
    height = 950;
    rerender(<TurnLog>{lines(['a', 'b'], false)}</TurnLog>);
    await waitFor(() => expect(last()).toBe(950));
  });

  it('stops observing on unmount', () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { unmount } = render(<TurnLog>{lines(['a'])}</TurnLog>);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
