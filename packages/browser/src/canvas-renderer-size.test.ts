/**
 * CanvasRenderer — backing-store sizing.
 *
 * The renderer draws into `ctx.canvas.width/height`. Nothing else in the
 * stack sets them: the playa facade gives the canvas a CSS size only, so an
 * unsized canvas keeps the 300x150 HTML default and every frame is
 * downscaled to it and stretched back up by CSS — the whole WebCodecs path
 * plays at 1/20th of its resolution.
 */
import { describe, expect, it, vi } from 'vitest';
import { CanvasRenderer } from './canvas-renderer.js';

function stubCanvas(width = 300, height = 150) {
  const canvas = { width, height };
  const drawImage = vi.fn();
  const ctx = { drawImage, clearRect() {}, canvas };
  return {
    canvas,
    drawImage,
    el: { getContext: () => ctx } as unknown as HTMLCanvasElement,
  };
}

function frame(opts: { displayWidth?: number; displayHeight?: number;
                       codedWidth?: number; codedHeight?: number } = {}) {
  return { timestamp: 0, close: vi.fn(), ...opts };
}

const clock = { now: () => 0 };

/** Enqueue at render time 0 and present it. */
function present(renderer: CanvasRenderer, f: unknown) {
  renderer.enqueue(f, 0);
  renderer.renderTick(0);
}

describe('CanvasRenderer backing store', () => {
  it('adopts the frame display size instead of the 300x150 default', () => {
    const { canvas, drawImage, el } = stubCanvas();
    const renderer = new CanvasRenderer(el, { clock });

    present(renderer, frame({ displayWidth: 1280, displayHeight: 720 }));

    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    // Full-size blit: no downscale, and the 16:9 frame is not squeezed to 2:1.
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 720);
  });

  it('prefers display over coded dimensions (macroblock padding, pixel aspect)', () => {
    const { canvas, el } = stubCanvas();
    const renderer = new CanvasRenderer(el, { clock });

    present(renderer, frame({
      displayWidth: 1920, displayHeight: 1080, codedWidth: 1920, codedHeight: 1088,
    }));

    expect(canvas.height).toBe(1080);
  });

  it('falls back to coded dimensions when display is absent', () => {
    const { canvas, el } = stubCanvas();
    const renderer = new CanvasRenderer(el, { clock });

    present(renderer, frame({ codedWidth: 640, codedHeight: 360 }));

    expect([canvas.width, canvas.height]).toEqual([640, 360]);
  });

  it('does not resize when the size is unchanged (a resize clears the canvas)', () => {
    const { canvas, el } = stubCanvas(1280, 720);
    const renderer = new CanvasRenderer(el, { clock });
    let writes = 0;
    for (const dim of ['width', 'height'] as const) {
      let v = canvas[dim];
      Object.defineProperty(canvas, dim, {
        get: () => v,
        set: (next: number) => { writes++; v = next; },
      });
    }

    present(renderer, frame({ displayWidth: 1280, displayHeight: 720 }));
    expect(writes).toBe(0);

    present(renderer, frame({ displayWidth: 640, displayHeight: 360 }));
    expect(writes).toBe(2);                       // a real change still resizes
    expect([canvas.width, canvas.height]).toEqual([640, 360]);
  });

  it('leaves the canvas alone for a frame carrying no dimensions', () => {
    const { canvas, drawImage, el } = stubCanvas();
    const renderer = new CanvasRenderer(el, { clock });

    present(renderer, frame());

    expect([canvas.width, canvas.height]).toEqual([300, 150]);
    expect(drawImage).toHaveBeenCalledTimes(1);   // still presented
  });
});
