import type { Tour } from '@gitscribe/core';
import type { Segment } from './video-timeline.js';

/**
 * A soundtrack for a tour video, rendered offline so it is exact and repeatable.
 *
 * One piece in C major: a soft pad on C–Am–F–G, a quiet bass, a note as each
 * stop begins, and a chime on the title and the outro. Everything sits in the
 * same key so the cues blend into the music instead of sitting on top.
 * Levels are set for roughly -16 LUFS, the loudness social platforms expect.
 */

export const SAMPLE_RATE = 48_000;

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export async function renderSoundtrack(tour: Tour, segs: readonly Segment[]): Promise<AudioBuffer> {
  const seconds = tour.totalMs / 1000;
  const ctx = new OfflineAudioContext(2, Math.ceil(SAMPLE_RATE * seconds), SAMPLE_RATE);

  // Output chain: gain → compressor acting as a gentle limiter → out.
  const master = ctx.createGain();
  master.gain.value = 3.4;   // measured: 1.6 gave -22.6 LUFS; target is about -16
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  master.connect(limiter).connect(ctx.destination);

  // A small synthetic room, so notes have a tail instead of stopping dead.
  const room = ctx.createConvolver();
  const ir = ctx.createBuffer(2, SAMPLE_RATE * 2, SAMPLE_RATE);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    // Deterministic noise, so two renders of one tour are identical.
    let seed = 12345 + ch;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = ((seed / 0x7fffffff) * 2 - 1) * (1 - i / d.length) ** 3;
    }
  }
  room.buffer = ir;
  const roomIn = ctx.createGain();
  roomIn.gain.value = 0.3;
  roomIn.connect(room).connect(master);

  const voice = (midi: number, at: number, dur: number, vol: number, type: OscillatorType, attack = 0.012, wet = 0.5): void => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    o.type = type;
    o.frequency.value = hz(midi);
    f.type = 'lowpass';
    f.frequency.value = type === 'triangle' ? 1100 : 2600;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, at + dur);
    o.connect(f).connect(g).connect(master);
    const send = ctx.createGain();
    send.gain.value = wet;
    g.connect(send).connect(roomIn);
    o.start(at);
    o.stop(at + dur + 0.05);
  };

  const beat = 60 / 80;
  const bar = beat * 4;
  const chords = [[48, 55, 60, 64], [45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 59]];
  for (let b = 0; b * bar < seconds; b++) {
    const at = b * bar;
    const last = at + bar >= seconds;
    const chord = last ? [48, 55, 60, 64, 67] : chords[b % 4]!;
    const len = Math.min(bar + 1.2, seconds - at + 0.5);
    for (const m of chord) voice(m, at, len, 0.05, 'triangle', 0.6, 0.6);
    voice(chord[0]! - 12, at, Math.min(bar, seconds - at), 0.09, 'sine', 0.02, 0.15);
  }

  const chime = (at: number): void => [72, 76, 79].forEach((m, i) => voice(m, at + i * 0.09, 2.2, 0.06, 'sine', 0.01, 0.8));
  const notes = [79, 76, 81, 79, 84, 81, 76, 79];
  for (const s of segs) {
    if (s.kind === 'intro') chime(s.start / 1000 + 0.15);
    if (s.kind === 'stop') voice(notes[s.stop! % notes.length]!, s.start / 1000 + 0.05, 1.1, 0.07, 'sine', 0.01, 0.7);
    if (s.kind === 'outro') chime(s.start / 1000 + 0.4);
  }

  return ctx.startRendering();
}
