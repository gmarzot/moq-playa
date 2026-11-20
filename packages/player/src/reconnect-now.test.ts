import { describe, it, expect, vi, afterEach } from 'vitest';
import { MoqtPlayer } from './player.js';

afterEach(() => { vi.useRealTimers(); });

function player() {
  return new MoqtPlayer({
    url: 'https://relay.example/moq', namespace: 'test', logLevel: 'none',
    createConnection: () => ({}) as never, createTransport: async () => ({}) as never,
  } as never);
}

describe('MoqtPlayer.reconnectNow', () => {
  it('runs a reconnect waiting out its backoff now, with the backoff restarted', async () => {
    vi.useFakeTimers();
    const p = player();
    const migrate = vi.fn(async () => {});
    (p as any).migrate = migrate;
    const waiting = vi.fn();
    const r = { attempt: 5, timer: setTimeout(waiting, 15_000), closeReason: 'Connection lost.' };
    (p as any).reconnect = r;

    p.reconnectNow();
    expect(migrate).toHaveBeenCalledOnce();
    expect(r.attempt).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(waiting).not.toHaveBeenCalled();
    expect((p as any).reconnect).toBeNull();
  });

  it('does nothing without a pending attempt', () => {
    const p = player();
    const migrate = vi.fn(async () => {});
    (p as any).migrate = migrate;
    p.reconnectNow();
    (p as any).reconnect = { attempt: 1, timer: null, closeReason: 'x' };
    p.reconnectNow();
    expect(migrate).not.toHaveBeenCalled();
  });
});
