/**
 * Synchronized Multi-Track Web Audio Engine for Logic-style Stem Playback
 */

export function extractPeaks(buffer: AudioBuffer, numBuckets = 240): number[] {
  const channel = buffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(channel.length / numBuckets));
  const peaks: number[] = [];
  for (let i = 0; i < numBuckets; i++) {
    const start = i * blockSize;
    const end = Math.min(channel.length, start + blockSize);
    let max = 0;
    for (let j = start; j < end; j++) {
      const val = Math.abs(channel[j]);
      if (val > max) max = val;
    }
    peaks.push(max);
  }
  return peaks;
}

interface TrackNode {
  buffer: AudioBuffer;
  gain: GainNode;
  panner: StereoPannerNode;
  source?: AudioBufferSourceNode;
}

export class MultiTrackAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private tracks = new Map<string, TrackNode>();
  private isPlaying = false;
  private startTime = 0;
  private pauseOffset = 0;
  private duration = 0;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async loadStems(
    stems: Array<{ id: string; buffer: ArrayBuffer }>
  ): Promise<Map<string, { peaks: number[]; duration: number }>> {
    this.stop();
    this.tracks.clear();
    const ctx = this.ensureContext();
    const infoMap = new Map<string, { peaks: number[]; duration: number }>();
    let maxDur = 0;

    for (const stem of stems) {
      const decoded = await ctx.decodeAudioData(stem.buffer.slice(0));
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      gain.connect(panner);
      panner.connect(this.masterGain!);
      this.tracks.set(stem.id, { buffer: decoded, gain, panner });
      if (decoded.duration > maxDur) maxDur = decoded.duration;
      infoMap.set(stem.id, {
        peaks: extractPeaks(decoded, 260),
        duration: decoded.duration
      });
    }

    this.duration = maxDur;
    this.pauseOffset = 0;
    return infoMap;
  }

  setMasterVolume(vol: number): void {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.015);
    }
  }

  updateTrack(id: string, volume: number, pan: number, audible: boolean): void {
    const node = this.tracks.get(id);
    if (!node || !this.ctx) return;
    node.gain.gain.setTargetAtTime(audible ? volume : 0, this.ctx.currentTime, 0.015);
    node.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.015);
  }

  play(offset?: number): void {
    if (this.tracks.size === 0) return;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    this.stopSources();

    if (typeof offset === 'number') {
      this.pauseOffset = Math.max(0, Math.min(offset, this.duration));
    }
    if (this.pauseOffset >= this.duration) {
      this.pauseOffset = 0;
    }

    const startAt = ctx.currentTime + 0.02;
    this.startTime = startAt - this.pauseOffset;

    for (const node of this.tracks.values()) {
      const src = ctx.createBufferSource();
      src.buffer = node.buffer;
      src.connect(node.gain);
      src.start(startAt, this.pauseOffset);
      node.source = src;
    }
    this.isPlaying = true;
  }

  pause(): void {
    if (!this.isPlaying || !this.ctx) return;
    this.pauseOffset = this.getCurrentTime();
    this.stopSources();
    this.isPlaying = false;
  }

  stop(): void {
    this.stopSources();
    this.isPlaying = false;
    this.pauseOffset = 0;
  }

  seek(timeSec: number): void {
    const clamped = Math.max(0, Math.min(timeSec, this.duration));
    if (this.isPlaying) {
      this.play(clamped);
    } else {
      this.pauseOffset = clamped;
    }
  }

  getCurrentTime(): number {
    if (!this.isPlaying || !this.ctx) return this.pauseOffset;
    const t = this.ctx.currentTime - this.startTime;
    if (t >= this.duration) {
      this.stop();
      return 0;
    }
    return Math.max(0, t);
  }

  getDuration(): number {
    return this.duration;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  private stopSources(): void {
    for (const node of this.tracks.values()) {
      if (node.source) {
        try {
          node.source.stop();
          node.source.disconnect();
        } catch {
          // already stopped
        }
        node.source = undefined;
      }
    }
  }

  dispose(): void {
    this.stop();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
