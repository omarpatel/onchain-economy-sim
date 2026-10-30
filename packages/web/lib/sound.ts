"use client";

export type Cue = "hover" | "place" | "fill" | "dividend" | "error" | "complete";

/**
 * WebAudio-synthesized UI cues — no asset files. The AudioContext is created
 * lazily on the first unmuted play (browsers require a user gesture), so the
 * module is safe to import during SSR. Muted by default; the hotbar toggles.
 */
class Synth {
  private ctx: AudioContext | null = null;
  private muted = true;
  private lastHover = 0;

  setMuted(m: boolean): void {
    this.muted = m;
    if (!m) this.ensure();
  }

  isMuted(): boolean {
    return this.muted;
  }

  play(cue: Cue): void {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    switch (cue) {
      case "hover": {
        // throttle: the pointer sweeps many tiles per second
        if (t - this.lastHover < 0.05) return;
        this.lastHover = t;
        this.tone(ctx, "square", 1800, t, 0.03, 0.012);
        break;
      }
      case "place":
        this.tone(ctx, "sine", 110, t, 0.18, 0.25, 55);
        this.noise(ctx, t, 0.08, 0.12);
        break;
      case "fill":
        this.tone(ctx, "triangle", 880, t, 0.09, 0.08);
        this.tone(ctx, "triangle", 1320, t + 0.07, 0.12, 0.08);
        break;
      case "dividend":
        this.tone(ctx, "sine", 659, t, 0.12, 0.07);
        this.tone(ctx, "sine", 784, t + 0.1, 0.12, 0.07);
        this.tone(ctx, "sine", 1047, t + 0.2, 0.25, 0.08);
        break;
      case "complete":
        // Soft low bloom under a rising major-seventh arpeggio: "it's built".
        this.tone(ctx, "sine", 196, t, 0.5, 0.09, 262);
        this.tone(ctx, "triangle", 523, t, 0.22, 0.06);
        this.tone(ctx, "triangle", 659, t + 0.08, 0.22, 0.06);
        this.tone(ctx, "triangle", 784, t + 0.16, 0.26, 0.06);
        this.tone(ctx, "sine", 988, t + 0.24, 0.5, 0.05);
        this.tone(ctx, "sine", 1568, t + 0.24, 0.35, 0.02);
        break;
      case "error":
        this.tone(ctx, "sawtooth", 140, t, 0.22, 0.09, 120);
        break;
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === "undefined") return null;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    return this.ctx;
  }

  /** Exponentially-decaying oscillator; optional pitch glide to `to` Hz. */
  private tone(ctx: AudioContext, type: OscillatorType, hz: number, at: number, dur: number, gain: number, to?: number): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, at);
    if (to !== undefined) osc.frequency.exponentialRampToValueAtTime(to, at + dur);
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.01);
  }

  /** Short filtered white-noise burst (the "thud" body). */
  private noise(ctx: AudioContext, at: number, dur: number, gain: number): void {
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 400;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start(at);
  }
}

export const sound = new Synth();
