// Tiny WebAudio synth: beeps, shutter, stepper motor, paper tear
export const Sound = {
  enabled: true,
  ctx: null, master: null, noiseBuf: null, motorNodes: null,
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 1.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return true;
    } catch { return false; }
  },
  ok() { return this.enabled && this.ensure(); },
  noise(loop = false) { const n = this.ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = loop; return n; },
  beep(freq = 880, dur = 0.07, vol = 0.07) {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * 0.5, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 3000;
    o.connect(f).connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  },
  shutter() {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime;
    const n = this.noise(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'highpass'; f.frequency.value = 2400;
    g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    n.connect(f).connect(g).connect(this.master); n.start(t); n.stop(t + 0.09);
    const n2 = this.noise(), f2 = c.createBiquadFilter(), g2 = c.createGain();
    f2.type = 'bandpass'; f2.frequency.value = 1200;
    g2.gain.setValueAtTime(0, t + 0.08); g2.gain.linearRampToValueAtTime(0.18, t + 0.085); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    n2.connect(f2).connect(g2).connect(this.master); n2.start(t + 0.08); n2.stop(t + 0.16);
  },
  motor(on) {
    if (on) {
      if (!this.ok() || this.motorNodes) return;
      const c = this.ctx, t = c.currentTime;
      const out = c.createGain(); out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(0.11, t + 0.05);
      out.connect(this.master);
      // stepper chatter: band-passed noise chopped by a square LFO
      const n = this.noise(true), bp = c.createBiquadFilter(), am = c.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 2100; bp.Q.value = 1.4;
      am.gain.value = 0.5;
      const lfo = c.createOscillator(), lfoG = c.createGain();
      lfo.type = 'square'; lfo.frequency.value = 38; lfoG.gain.value = 0.5;
      lfo.connect(lfoG).connect(am.gain);
      n.connect(bp).connect(am).connect(out);
      // low hum
      const hum = c.createOscillator(), lp = c.createBiquadFilter(), hg = c.createGain();
      hum.type = 'sawtooth'; hum.frequency.value = 96; lp.type = 'lowpass'; lp.frequency.value = 420; hg.gain.value = 0.35;
      hum.connect(lp).connect(hg).connect(out);
      n.start(t); lfo.start(t); hum.start(t);
      this.motorNodes = { out, n, lfo, hum, lfoF: lfo.frequency };
    } else if (this.motorNodes) {
      const { out, n, lfo, hum } = this.motorNodes; const t = this.ctx.currentTime;
      out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0, t + 0.06);
      [n, lfo, hum].forEach((x) => x.stop(t + 0.08));
      this.motorNodes = null;
    }
  },
  motorStutter(slow) { if (this.motorNodes) this.motorNodes.lfoF.setTargetAtTime(slow ? 9 : 38, this.ctx.currentTime, 0.01); },
  tear() {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime, dur = 0.26;
    const n = this.noise(), bp = c.createBiquadFilter(), g = c.createGain();
    bp.type = 'bandpass'; bp.frequency.setValueAtTime(2600, t); bp.frequency.linearRampToValueAtTime(4800, t + dur); bp.Q.value = 0.8;
    const curve = new Float32Array(48);
    for (let i = 0; i < curve.length; i++) { const p = i / (curve.length - 1); curve[i] = (Math.random() * 0.7 + 0.3) * Math.sin(Math.PI * Math.min(1, p * 1.4)) * 0.5 * (1 - p * 0.6); }
    g.gain.setValueCurveAtTime(curve, t, dur);
    n.connect(bp).connect(g).connect(this.master); n.start(t); n.stop(t + dur + 0.02);
  },

  // paper being crushed: a burst of tiny crackles
  crumple(dur = 0.75) {
    if (!this.ok()) return;
    const c = this.ctx, t0 = c.currentTime;
    const count = 26;
    for (let i = 0; i < count; i++) {
      const t = t0 + Math.pow(Math.random(), 0.8) * dur;
      const n = this.noise(), bp = c.createBiquadFilter(), g = c.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 1400 + Math.random() * 3800; bp.Q.value = 0.7 + Math.random() * 1.5;
      const len = 0.012 + Math.random() * 0.05, v = 0.06 + Math.random() * 0.22;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0008, t + len);
      n.connect(bp).connect(g).connect(this.master);
      const off = Math.random() * 1.2;
      n.start(t, off); n.stop(t + len + 0.02);
    }
  },
  // the ball flying through the air
  whoosh(dur = 0.55) {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime;
    const n = this.noise(), bp = c.createBiquadFilter(), g = c.createGain();
    bp.type = 'bandpass'; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(380, t); bp.frequency.exponentialRampToValueAtTime(1500, t + dur * 0.55); bp.frequency.exponentialRampToValueAtTime(600, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + dur * 0.45); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(bp).connect(g).connect(this.master); n.start(t); n.stop(t + dur + 0.05);
  },
  // landing in the bin
  thunk() {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.16);
    g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.22);
    const n = this.noise(), lp = c.createBiquadFilter(), g2 = c.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    g2.gain.setValueAtTime(0.25, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    n.connect(lp).connect(g2).connect(this.master); n.start(t); n.stop(t + 0.1);
  },
};
