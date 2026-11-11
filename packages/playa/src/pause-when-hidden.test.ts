import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Player } from './player.js';
import type { LifecycleEvent } from './events.js';

const doc = { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  createElement: () => ({ style: {}, appendChild: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    getContext: vi.fn(() => ({ drawImage: vi.fn() })) }) };

beforeEach(() => {
  vi.useFakeTimers();
  doc.hidden = false;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(opts: { pauseWhenHidden?: boolean; muted?: boolean } = {}) {
  const player = new Player({ style: {}, appendChild: vi.fn() } as never, {
    url: 'https://relay.example/moq', namespace: 'test', audioActivation: 'gesture',
    pauseWhenHidden: opts.pauseWhenHidden ?? true, muted: opts.muted ?? true,
  });
  const engine = (player as any).engine;
  vi.spyOn(engine, 'reconnectNow').mockImplementation(() => {});
  vi.spyOn(engine, 'resumeSuspendedPlayback').mockImplementation(() => {});
  const enginePause = vi.spyOn(engine, 'pause').mockImplementation(() => {});
  const enginePlay = vi.spyOn(engine, 'play').mockImplementation(() => {});
  const lifecycle: LifecycleEvent[] = [];
  player.on('lifecycle', (e) => { lifecycle.push(e); });
  player.play();
  enginePlay.mockClear();
  const hide = () => { doc.hidden = true; (player as any).onLifecycle('hidden'); };
  const show = () => { doc.hidden = false; (player as any).onLifecycle('visible'); };
  return { player, enginePause, enginePlay, lifecycle, hide, show };
}

describe('Player — pauseWhenHidden', () => {
  it('a muted page hidden 60 s pauses, and rejoins live once when visible', async () => {
    const s = setup();
    try {
      s.hide();
      vi.advanceTimersByTime(59_000);
      expect(s.enginePause).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(s.enginePause).toHaveBeenCalledTimes(1);
      expect(s.player.state).toBe('paused');
      expect(s.lifecycle.at(-1)).toEqual({ state: 'hidden', paused: 'silent' });

      vi.advanceTimersByTime(120_000);
      s.show();
      expect(s.enginePlay).toHaveBeenCalledTimes(1);
      expect(s.player.state).toBe('playing');
      expect(s.lifecycle.at(-1)).toMatchObject({ state: 'visible', rejoined: true });
    } finally { await s.player.destroy(); }
  });

  it('an audible page keeps playing while hidden', async () => {
    const s = setup({ muted: false });
    try {
      s.hide();
      vi.advanceTimersByTime(300_000);
      expect(s.enginePause).not.toHaveBeenCalled();
    } finally { await s.player.destroy(); }
  });

  it('a page back within 60 s was never paused', async () => {
    const s = setup();
    try {
      s.hide();
      vi.advanceTimersByTime(30_000);
      s.show();
      vi.advanceTimersByTime(120_000);
      expect(s.enginePause).not.toHaveBeenCalled();
      expect(s.enginePlay).not.toHaveBeenCalled();
      expect(s.lifecycle.at(-1)).toEqual({ state: 'visible', awayMs: 30_000 });
    } finally { await s.player.destroy(); }
  });

  it('timers running 30 s late pause an audible page too', async () => {
    const s = setup({ muted: false });
    try {
      s.hide();
      vi.advanceTimersByTime(5_000);
      vi.setSystemTime(Date.now() + 30_000);         // the browser ran no timers for 30 s
      vi.advanceTimersByTime(1_000);
      expect(s.enginePause).toHaveBeenCalledTimes(1);
      expect(s.lifecycle.at(-1)).toMatchObject({ state: 'hidden', paused: 'throttled' });
      expect((s.lifecycle.at(-1) as LifecycleEvent).lateMs).toBeGreaterThanOrEqual(30_000);
    } finally { await s.player.destroy(); }
  });

  it('a pause before hiding stays a pause', async () => {
    const s = setup();
    try {
      s.player.pause();
      s.enginePause.mockClear();
      s.hide();
      vi.advanceTimersByTime(120_000);
      s.show();
      expect(s.enginePause).not.toHaveBeenCalled();
      expect(s.enginePlay).not.toHaveBeenCalled();
      expect(s.player.state).toBe('paused');
    } finally { await s.player.destroy(); }
  });

  it('a page resumed while still hidden stays paused', async () => {
    const s = setup();
    try {
      s.hide();
      vi.advanceTimersByTime(61_000);
      (s.player as any).onLifecycle('resumed');
      expect(s.enginePlay).not.toHaveBeenCalled();
      expect(s.player.state).toBe('paused');
      s.show();
      expect(s.enginePlay).toHaveBeenCalledTimes(1);
    } finally { await s.player.destroy(); }
  });

  it('off by default', async () => {
    const s = setup({ pauseWhenHidden: false });
    try {
      s.hide();
      vi.advanceTimersByTime(300_000);
      expect(s.enginePause).not.toHaveBeenCalled();
    } finally { await s.player.destroy(); }
  });
});
