import { contextBridge, ipcRenderer } from 'electron';

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

contextBridge.exposeInMainWorld('musicSplitter', {
  checkEnvironment: (): Promise<EnvStatus> => ipcRenderer.invoke('check-environment'),
  setupEnvironment: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('setup-environment'),
  resetEnvironment: (): Promise<{ ok: boolean; removed: string[] }> => ipcRenderer.invoke('reset-environment'),
  onSetupLog: (cb: (line: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on('setup-log', listener);
    return () => ipcRenderer.removeListener('setup-log', listener);
  },

  selectAudioFile: (): Promise<string | null> => ipcRenderer.invoke('select-audio-file'),
  getAudioInfo: (filePath: string): Promise<AudioInfo> => ipcRenderer.invoke('get-audio-info', filePath),
  readAudioBuffer: (filePath: string): Promise<ArrayBuffer> => ipcRenderer.invoke('read-audio-buffer', filePath),

  startSeparation: (params: {
    inputPath: string;
    mode: SeparationMode;
    format: AudioFormat;
    device?: 'auto' | 'cpu' | 'cuda' | 'mps';
  }): Promise<{ ok: boolean; stems?: StemResult[]; outputDir?: string; error?: string }> =>
    ipcRenderer.invoke('start-separation', params),
  cancelSeparation: (): Promise<void> => ipcRenderer.invoke('cancel-separation'),
  onSeparationProgress: (cb: (ev: SeparationProgressEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, ev: SeparationProgressEvent) => cb(ev);
    ipcRenderer.on('separation-progress', listener);
    return () => ipcRenderer.removeListener('separation-progress', listener);
  },

  exportSingleStem: (params: {
    sourcePath: string;
    defaultName: string;
    format: AudioFormat;
  }): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('export-single-stem', params),

  exportAllStems: (params: {
    stems: StemResult[];
    format: AudioFormat;
  }): Promise<{ ok: boolean; targetDir?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('export-all-stems', params),

  exportCustomMix: (params: {
    stems: Array<{ path: string; volume: number }>;
    format: AudioFormat;
    defaultName: string;
  }): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('export-custom-mix', params),

  openFolder: (targetPath: string): Promise<void> => ipcRenderer.invoke('open-folder', targetPath)
});
