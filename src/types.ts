export type SeparationMode = '2stems' | '4stems' | '4stems_hq' | '6stems';
export type AudioFormat = 'wav' | 'mp3' | 'flac' | 'ogg';

export interface StemResult {
  id: string;
  name: string;
  path: string;
  format: AudioFormat;
}

export interface EnvStatus {
  ready: boolean;
  pythonPath: string | null;
  systemPython: string | null;
  venvDir: string;
  ffmpegPath: string;
  hasGpu: boolean;
  gpuName?: string;
}

export interface AudioInfo {
  duration: number;
  formatName: string;
  sampleRate: number;
  channels: number;
  bitRate: number;
  sizeBytes: number;
}

export interface SeparationProgressEvent {
  type: 'progress' | 'status' | 'done' | 'error';
  percent?: number;
  stage?: string;
  message?: string;
  stems?: StemResult[];
  device?: string;
  model?: string;
}

export interface StemTrackState {
  id: string;
  name: string;
  path: string;
  format: AudioFormat;
  volume: number; // 0.0 to 1.5
  pan: number; // -1.0 to 1.0
  muted: boolean;
  solo: boolean;
  peaks: number[];
  color: string;
}

declare global {
  interface Window {
    musicSplitter: {
      checkEnvironment: () => Promise<EnvStatus>;
      setupEnvironment: () => Promise<{ ok: boolean; error?: string }>;
      resetEnvironment: () => Promise<{ ok: boolean; removed: string[] }>;
      onSetupLog: (cb: (line: string) => void) => () => void;
      selectAudioFile: () => Promise<string | null>;
      getAudioInfo: (filePath: string) => Promise<AudioInfo>;
      readAudioBuffer: (filePath: string) => Promise<ArrayBuffer>;
      startSeparation: (params: {
        inputPath: string;
        mode: SeparationMode;
        format: AudioFormat;
        device?: 'auto' | 'cpu' | 'cuda' | 'mps';
      }) => Promise<{ ok: boolean; stems?: StemResult[]; outputDir?: string; error?: string }>;
      cancelSeparation: () => Promise<void>;
      onSeparationProgress: (cb: (ev: SeparationProgressEvent) => void) => () => void;
      pitchShiftStems: (params: {
        stems: Array<{ id: string; path: string }>;
        semitones: number;
        sessionDir?: string;
      }) => Promise<{ ok: boolean; results?: Array<{ id: string; path: string }>; error?: string }>;
      exportSingleStem: (params: {
        sourcePath: string;
        defaultName: string;
        format: AudioFormat;
        stemId?: string;
        pitchSemitones?: number;
        sessionDir?: string;
      }) => Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }>;
      exportAllStems: (params: {
        stems: StemResult[];
        format: AudioFormat;
        pitchSemitones?: number;
        sessionDir?: string;
      }) => Promise<{ ok: boolean; targetDir?: string; canceled?: boolean }>;
      exportCustomMix: (params: {
        stems: Array<{ id?: string; path: string; volume: number }>;
        format: AudioFormat;
        defaultName: string;
        pitchSemitones?: number;
        sessionDir?: string;
      }) => Promise<{ ok: boolean; savedPath?: string; canceled?: boolean; error?: string }>;
      convertStemToMidi: (params: {
        sourcePath: string;
        stemId: string;
        defaultName: string;
        pitchSemitones?: number;
        sessionDir?: string;
      }) => Promise<{
        ok: boolean;
        savedPath?: string;
        noteCount?: number;
        bpm?: number;
        canceled?: boolean;
        error?: string;
      }>;
      convertStemsToMidi: (params: {
        stems: Array<{ id: string; name: string; path: string }>;
        mode: 'individual' | 'combined';
        defaultName: string;
        pitchSemitones?: number;
        sessionDir?: string;
      }) => Promise<{
        ok: boolean;
        savedPath?: string;
        targetDir?: string;
        files?: string[];
        noteCount?: number;
        bpm?: number;
        canceled?: boolean;
        error?: string;
      }>;
      onMidiProgress: (
        cb: (ev: { type: string; percent?: number; message?: string }) => void
      ) => () => void;
      openFolder: (targetPath: string) => Promise<void>;
    };
  }
}
