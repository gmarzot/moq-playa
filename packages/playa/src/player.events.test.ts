/**
 * Facade event forwarding: engine events re-emitted in the facade's shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Player } from './player.js';
import type { SessionClosedEvent } from './events.js';

// ─── DOM / global mocks ──────────────────────────────────────────────

function mockElement(): any {
  const style: Record<string, string> = {};
  return {
    style: new Proxy(style, { set: (t, k, v) => { t[k as string] = v; return true; } }),
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    addEventListener: vi.fn(),
    getContext: vi.fn(() => ({ drawImage: vi.fn() })),
    width: 0, height: 0,
    hidden: false, muted: false, volume: 1, playsInline: false,
    parentNode: null as any,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    load: vi.fn(),
    disableRemotePlayback: false,
  };
}

beforeEach(() => {
  (globalThis as any).document = {
    createElement: (_tag: string) => mockElement(),
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).HTMLCanvasElement = class {};
  (globalThis as any).HTMLVideoElement = class {};
  (globalThis as any).requestAnimationFrame = vi.fn(() => 0);
  (globalThis as any).cancelAnimationFrame = vi.fn();
  (globalThis as any).AudioContext = class {
    state = 'suspended';
    currentTime = 0;
    outputLatency = 0;
    destination = { maxChannelCount: 2 };
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
    createGain = vi.fn(() => ({ gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn() }));
    getOutputTimestamp = vi.fn(() => ({ contextTime: 0, performanceTime: 0 }));
  };
});

function createPlayer(): Player {
  const container = mockElement();
  container.parentNode = { removeChild: vi.fn() };
  return new Player(container, { url: 'https://relay.example.com/moq', namespace: 'test' });
}

// ─── session_closed ──────────────────────────────────────────────────

describe('Player — session_closed', () => {
  it('forwards the engine close with its code and reason', () => {
    const player = createPlayer();
    const seen: SessionClosedEvent[] = [];
    player.on('session_closed', (e) => seen.push(e));

    (player as any).engine.emitter.emit('session_closed', {
      type: 'session_closed', error: 0x10, reason: 'publisher gone',
    });

    expect(seen).toEqual([{ code: 0x10, reason: 'publisher gone' }]);
  });

  it('forwards a close that carries neither, without inventing fields', () => {
    const player = createPlayer();
    const seen: SessionClosedEvent[] = [];
    player.on('session_closed', (e) => seen.push(e));

    (player as any).engine.emitter.emit('session_closed', { type: 'session_closed' });

    expect(seen).toEqual([{}]);
  });
});
