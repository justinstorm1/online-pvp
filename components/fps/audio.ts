/** Synthesized sound effects — no audio files to load. */
export class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null

  /** Must be called from a user gesture (browsers block autoplay). */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.5
      this.master.connect(this.ctx.destination)
      const len = this.ctx.sampleRate
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const data = this.noise.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    }
    if (this.ctx.state === "suspended") void this.ctx.resume()
  }

  private burst(opts: { duration: number; freq: number; q?: number; gain: number; type?: BiquadFilterType }) {
    const { ctx, master, noise } = this
    if (!ctx || !master || !noise) return
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = noise
    const filter = ctx.createBiquadFilter()
    filter.type = opts.type ?? "lowpass"
    filter.frequency.setValueAtTime(opts.freq, t)
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, opts.freq / 8), t + opts.duration)
    filter.Q.value = opts.q ?? 0.7
    const g = ctx.createGain()
    g.gain.setValueAtTime(opts.gain, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.duration)
    src.connect(filter).connect(g).connect(master)
    src.start(t, Math.random() * 0.5)
    src.stop(t + opts.duration)
  }

  private tone(opts: { from: number; to: number; duration: number; gain: number; type?: OscillatorType; delay?: number }) {
    const { ctx, master } = this
    if (!ctx || !master) return
    const t = ctx.currentTime + (opts.delay ?? 0)
    const osc = ctx.createOscillator()
    osc.type = opts.type ?? "square"
    osc.frequency.setValueAtTime(opts.from, t)
    osc.frequency.exponentialRampToValueAtTime(opts.to, t + opts.duration)
    const g = ctx.createGain()
    g.gain.setValueAtTime(opts.gain, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.duration)
    osc.connect(g).connect(master)
    osc.start(t)
    osc.stop(t + opts.duration)
  }

  /** volume < 1 for other players' shots, attenuated by distance. */
  shoot(volume = 1) {
    this.burst({ duration: 0.18, freq: 4200 * (0.6 + volume * 0.4), gain: 0.9 * volume })
    this.tone({ from: 160, to: 40, duration: 0.12, gain: 0.5 * volume, type: "sine" })
  }
  enemyShoot() {
    this.tone({ from: 900, to: 220, duration: 0.18, gain: 0.12, type: "sawtooth" })
  }
  hit() {
    this.tone({ from: 1400, to: 1100, duration: 0.05, gain: 0.15, type: "triangle" })
  }
  headshot() {
    this.tone({ from: 1800, to: 1600, duration: 0.06, gain: 0.2, type: "triangle" })
    this.tone({ from: 2400, to: 2200, duration: 0.08, gain: 0.15, type: "triangle", delay: 0.05 })
  }
  kill() {
    this.tone({ from: 300, to: 60, duration: 0.35, gain: 0.25, type: "sawtooth" })
  }
  hurt() {
    this.burst({ duration: 0.25, freq: 900, gain: 0.6 })
    this.tone({ from: 120, to: 50, duration: 0.25, gain: 0.4, type: "sine" })
  }
  reload() {
    this.burst({ duration: 0.05, freq: 3000, gain: 0.3, type: "bandpass", q: 4 })
    setTimeout(() => this.burst({ duration: 0.06, freq: 2200, gain: 0.35, type: "bandpass", q: 4 }), 900)
  }
  empty() {
    this.burst({ duration: 0.03, freq: 5000, gain: 0.2, type: "highpass" })
  }
  pickup() {
    this.tone({ from: 600, to: 1200, duration: 0.15, gain: 0.2, type: "sine" })
    this.tone({ from: 900, to: 1800, duration: 0.2, gain: 0.15, type: "sine", delay: 0.08 })
  }
  wave() {
    this.tone({ from: 220, to: 220, duration: 0.25, gain: 0.2, type: "square" })
    this.tone({ from: 330, to: 330, duration: 0.4, gain: 0.2, type: "square", delay: 0.2 })
  }

  dispose() {
    void this.ctx?.close()
    this.ctx = null
  }
}
