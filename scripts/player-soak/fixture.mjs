/**
 * Synthetic camera and microphone for a headless g5-broadcast (Chrome's
 * --use-file-for-fake-video-capture / --use-file-for-fake-audio-capture),
 * written directly so the broadcaster needs no ffmpeg: diagonal bands moving
 * across eight color bars, with a white square on each second's first frame,
 * and a 440 Hz tone with a 100 ms 1 kHz beep on each second. Both loop at
 * `seconds`, so the flash and the beep stay aligned across loops.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';

/** BT.601 limited-range Cb/Cr for the eight color bars. */
const BARS = [[128, 128], [16, 146], [166, 16], [54, 34], [202, 222], [90, 240], [240, 110], [128, 128]];

export function yuvFrame(width, height, fps, n) {
  const ySize = width * height;
  const cw = width >> 1;
  const ch = height >> 1;
  const frame = Buffer.alloc(ySize + 2 * cw * ch);
  const shift = n * 8;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) frame[row + x] = 32 + (((x + y + shift) >> 3) & 0x7f) * 1.5;
  }
  const flash = n % fps === 0;
  const box = Math.round(height / 4.5);
  if (flash) for (let y = 0; y < box; y++) frame.fill(235, y * width, y * width + box);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const [cb, cr] = flash && x < box >> 1 && y < box >> 1 ? [128, 128] : BARS[Math.floor((x * 8) / cw)];
      frame[ySize + y * cw + x] = cb;
      frame[ySize + cw * ch + y * cw + x] = cr;
    }
  }
  return frame;
}

export function wavTone(seconds, rate = 48000) {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const v = t % 1 < 0.1 ? 0.5 * Math.sin(2 * Math.PI * 1000 * t) : 0.3 * Math.sin(2 * Math.PI * 440 * t);
    const s = Math.round(v * 32767);
    data.writeInt16LE(s, i * 4);
    data.writeInt16LE(s, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export async function prepareCamera(dir, { width = 1280, height = 720, fps = 30, seconds = 5 } = {}) {
  await mkdir(dir, { recursive: true });
  const video = join(dir, `camera-${height}p${fps}.y4m`);
  const audio = join(dir, 'microphone.wav');
  const out = createWriteStream(video);
  out.write(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`);
  for (let n = 0; n < seconds * fps; n++) {
    if (!out.write(Buffer.concat([Buffer.from('FRAME\n'), yuvFrame(width, height, fps, n)]))) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  await writeFile(audio, wavTone(seconds));
  return { video, audio, width, height, fps };
}
