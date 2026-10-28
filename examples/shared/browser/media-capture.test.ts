import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaCapture, cameraConstraints } from './media-capture.js';
import { PROGRAMME_AUDIO } from './programme-audio.js';

const stream = { getVideoTracks: () => [], getAudioTracks: () => [], getTracks: () => [] };
const getUserMedia = vi.fn(async (_c: MediaStreamConstraints) => stream);
const SIZE = { width: 1280, height: 720, frameRate: { ideal: 60 } };

function overconstrained(): Error {
  const err = new Error('facingMode');
  err.name = 'OverconstrainedError';
  return err;
}

beforeEach(() => {
  getUserMedia.mockReset();
  getUserMedia.mockImplementation(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('cameraConstraints', () => {
  it('leaves the constraints unchanged with no camera chosen', () => {
    expect(cameraConstraints(SIZE, null)).toEqual(SIZE);
    expect(cameraConstraints(undefined, null)).toBe(true);
  });

  it('asks for the front camera', () => {
    expect(cameraConstraints(SIZE, 'front')).toEqual({ ...SIZE, facingMode: 'user' });
  });

  it('requires the back camera', () => {
    expect(cameraConstraints(SIZE, 'back')).toEqual({ ...SIZE, facingMode: { exact: 'environment' } });
  });

  it('requires a chosen device', () => {
    expect(cameraConstraints(SIZE, 'abc123')).toEqual({ ...SIZE, deviceId: { exact: 'abc123' } });
    expect(cameraConstraints(undefined, 'abc123')).toEqual({ deviceId: { exact: 'abc123' } });
  });
});

describe('MediaCapture.startCamera — camera choice', () => {
  it('opens the chosen camera', async () => {
    await new MediaCapture().startCamera(SIZE, true, 'back');
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { ...SIZE, facingMode: { exact: 'environment' } }, audio: PROGRAMME_AUDIO,
    });
  });

  it('falls back to the default camera when the choice is overconstrained', async () => {
    getUserMedia.mockImplementationOnce(async () => { throw overconstrained(); });
    const cap = new MediaCapture();
    const onFallback = vi.fn();
    cap.onCameraFallback = onFallback;
    await cap.startCamera(SIZE, false, 'back');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: SIZE, audio: false });
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith('back', expect.objectContaining({ name: 'OverconstrainedError' }));
  });

  it('does not retry other errors, or an overconstrained default', async () => {
    const denied = new Error('denied');
    denied.name = 'NotAllowedError';
    getUserMedia.mockImplementationOnce(async () => { throw denied; });
    await expect(new MediaCapture().startCamera(SIZE, false, 'back')).rejects.toBe(denied);
    getUserMedia.mockImplementationOnce(async () => { throw overconstrained(); });
    await expect(new MediaCapture().startCamera(SIZE, false)).rejects.toThrow('facingMode');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
});
