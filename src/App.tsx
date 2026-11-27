import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Download,
  FileAudio,
  FolderOpen,
  Layers,
  Loader2,
  Pause,
  Play,
  Sliders,
  Sparkles,
  Square,
  Upload,
  Volume2,
  X
} from 'lucide-react';
import {
  AudioFormat,
  AudioInfo,
  EnvStatus,
  SeparationMode,
  StemTrackState
} from './types';
import { MultiTrackAudioEngine } from './utils/audioMixer';
import { StemTrackRow } from './components/StemTrackRow';

const STEM_COLORS: Record<string, string> = {
  vocals: '#ec4899', // pink-500
  instrumental: '#3b82f6', // blue-500
  drums: '#f59e0b', // amber-500
  bass: '#06b6d4', // cyan-500
  guitar: '#10b981', // emerald-500
  piano: '#8b5cf6', // violet-500
  other: '#64748b' // slate-500
};

const MODE_OPTIONS: Array<{
  id: SeparationMode;
  title: string;
  desc: string;
  badge: string;
}> = [
  {
    id: '2stems',
    title: '2 Stems (보컬 / 반주)',
    desc: '보컬과 반주(MR)로 빠르게 분리합니다',
    badge: '보컬/MR'
  },
  {
    id: '4stems',
    title: '4 Stems (표준 악기 분리)',
    desc: '보컬 · 드럼 · 베이스 · 기타 악기 4트랙 분리',
    badge: '표준'
  },
  {
    id: '6stems',
    title: '6 Stems (Logic Pro 풀 스템)',
    desc: '보컬 · 드럼 · 베이스 · 기타 · 피아노 · 기타 악기',
    badge: 'Logic 스타일'
  },
  {
    id: '4stems_hq',
    title: '4 Stems HQ (고품질 마스터)',
    desc: 'Fine-tuned 모델로 가장 정밀하게 4트랙 분리',
    badge: '고품질'
  }
];

const FORMAT_OPTIONS: AudioFormat[] = ['wav', 'mp3', 'flac', 'ogg'];

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00.0';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupLogs, setSetupLogs] = useState<string[]>([]);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [inputPath, setInputPath] = useState<string | null>(null);
  const [audioInfo, setAudioInfo] = useState<AudioInfo | null>(null);
  const [mode, setMode] = useState<SeparationMode>('6stems');
  const [format, setFormat] = useState<AudioFormat>('wav');

  const [isSeparating, setIsSeparating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const [sessionDir, setSessionDir] = useState<string | null>(null);
  const [tracks, setTracks] = useState<StemTrackState[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [masterVolume, setMasterVolume] = useState(1.0);
  const [isDragging, setIsDragging] = useState(false);

  const engineRef = useRef<MultiTrackAudioEngine | null>(null);
  const rafRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg((prev) => (prev === msg ? null : prev)), 3500);
  }, []);

  // Initialize audio engine & check environment
  useEffect(() => {
    engineRef.current = new MultiTrackAudioEngine();
    window.musicSplitter.checkEnvironment().then((status) => {
      setEnvStatus(status);
      if (!status.ready) {
        setSetupOpen(true);
      }
    });

    const unsubProgress = window.musicSplitter.onSeparationProgress((ev) => {
      if (typeof ev.percent === 'number') setProgress(ev.percent);
      if (ev.message) setProgressMsg(ev.message);
    });

    const unsubSetup = window.musicSplitter.onSetupLog((line) => {
      setSetupLogs((prev) => [...prev.slice(-80), line]);
    });

    return () => {
      unsubProgress();
      unsubSetup();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      engineRef.current?.dispose();
    };
  }, []);

  // Animation frame loop for playhead
  useEffect(() => {
    const tick = () => {
      const eng = engineRef.current;
      if (eng) {
        setCurrentTime(eng.getCurrentTime());
        setIsPlaying(eng.getIsPlaying());
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Sync track mute/solo/volume to Web Audio engine
  const anySolo = useMemo(() => tracks.some((t) => t.solo), [tracks]);

  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.setMasterVolume(masterVolume);
    for (const t of tracks) {
      const audible = anySolo ? t.solo && !t.muted : !t.muted;
      eng.updateTrack(t.id, t.volume, t.pan, audible);
    }
  }, [tracks, anySolo, masterVolume]);

  const loadSelectedFile = async (filePath: string) => {
    setErrorMsg(null);
    setInputPath(filePath);
    const info = await window.musicSplitter.getAudioInfo(filePath);
    setAudioInfo(info);
  };

  const handleSelectFile = async () => {
    const path = await window.musicSplitter.selectAudioFile();
    if (path) await loadSelectedFile(path);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
    if (file?.path) {
      await loadSelectedFile(file.path);
    }
  };

  const handleRunSetup = async () => {
    setSetupRunning(true);
    setSetupError(null);
    setSetupLogs(['AI 음원 분리 환경 구성을 시작합니다...']);
    const res = await window.musicSplitter.setupEnvironment();
    setSetupRunning(false);
    if (res.ok) {
      const status = await window.musicSplitter.checkEnvironment();
      setEnvStatus(status);
      setSetupOpen(false);
      showToast('AI 음원 분리 엔진 준비가 완료되었습니다!');
    } else {
      setSetupError(res.error || '환경 설정 중 오류가 발생했습니다.');
    }
  };

  const handleResetEnvironment = async () => {
    setSetupRunning(true);
    setSetupError(null);
    setSetupLogs(['기존 가상환경을 삭제하는 중...']);
    const res = await window.musicSplitter.resetEnvironment();
    const status = await window.musicSplitter.checkEnvironment();
    setEnvStatus(status);
    setSetupRunning(false);
    if (res.removed.length > 0) {
      setSetupLogs((prev) => [...prev, `삭제 완료: ${res.removed.join(', ')}`]);
      showToast('기존 가상환경을 삭제했습니다.');
    } else {
      setSetupLogs((prev) => [...prev, '삭제할 가상환경 폴더가 없습니다.']);
    }
  };

  const handleStartSeparation = async () => {
    if (!inputPath) return;
    setErrorMsg(null);
    setIsSeparating(true);
    setProgress(2);
    setProgressMsg('분리 작업 초기화 중...');
    engineRef.current?.stop();

    const res = await window.musicSplitter.startSeparation({
      inputPath,
      mode,
      format,
      device: 'auto'
    });

    setIsSeparating(false);

    if (!res.ok || !res.stems) {
      setErrorMsg(res.error || '음원 분리에 실패했습니다.');
      return;
    }

    setSessionDir(res.outputDir || null);
    setProgress(100);
    setProgressMsg('오디오 파형 로딩 중...');

    // Load all stems into Web Audio API mixer
    const buffers: Array<{ id: string; buffer: ArrayBuffer }> = [];
    for (const stem of res.stems) {
      const buf = await window.musicSplitter.readAudioBuffer(stem.path);
      buffers.push({ id: stem.id, buffer: buf });
    }

    const peakMap = await engineRef.current!.loadStems(buffers);
    let maxDur = 0;
    const nextTracks: StemTrackState[] = res.stems.map((s) => {
      const meta = peakMap.get(s.id);
      if (meta && meta.duration > maxDur) maxDur = meta.duration;
      return {
        ...s,
        volume: 1.0,
        pan: 0,
        muted: false,
        solo: false,
        peaks: meta?.peaks || [],
        color: STEM_COLORS[s.id] || '#3b82f6'
      };
    });

    setTracks(nextTracks);
    setDuration(maxDur);
    setCurrentTime(0);
    showToast(`${nextTracks.length}개 스템 분리가 완료되었습니다!`);
  };

  const handleCancelSeparation = async () => {
    await window.musicSplitter.cancelSeparation();
    setIsSeparating(false);
    setProgress(0);
    setProgressMsg('작업이 취소되었습니다.');
  };

  const handleTogglePlay = () => {
    const eng = engineRef.current;
    if (!eng || tracks.length === 0) return;
    if (eng.getIsPlaying()) {
      eng.pause();
      setIsPlaying(false);
    } else {
      eng.play();
      setIsPlaying(true);
    }
  };

  const handleStop = () => {
    engineRef.current?.stop();
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const handleSeek = (ratio: number) => {
    if (!engineRef.current || duration <= 0) return;
    const t = ratio * duration;
    engineRef.current.seek(t);
    setCurrentTime(t);
  };

  const handleToggleMute = (id: string) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, muted: !t.muted } : t)));
  };

  const handleToggleSolo = (id: string) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, solo: !t.solo } : t)));
  };

  const handleVolumeChange = (id: string, volume: number) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, volume } : t)));
  };

  const applyPreset = (preset: 'all' | 'vocals_only' | 'instrumental_only') => {
    setTracks((prev) =>
      prev.map((t) => {
        if (preset === 'all') return { ...t, muted: false, solo: false };
        if (preset === 'vocals_only') return { ...t, muted: false, solo: t.id === 'vocals' };
        return { ...t, muted: t.id === 'vocals', solo: false };
      })
    );
  };

  const handleExportSingle = async (track: StemTrackState) => {
    const base = inputPath ? inputPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') : 'track';
    const res = await window.musicSplitter.exportSingleStem({
      sourcePath: track.path,
      defaultName: `${base}_${track.id}`,
      format
    });
    if (res.ok) showToast(`${track.name} 저장 완료!`);
  };

  const handleExportAll = async () => {
    if (tracks.length === 0) return;
    const res = await window.musicSplitter.exportAllStems({
      stems: tracks.map((t) => ({ id: t.id, name: t.name, path: t.path, format: t.format })),
      format
    });
    if (res.ok && res.targetDir) {
      showToast('모든 스템을 폴더에 저장했습니다!');
      await window.musicSplitter.openFolder(res.targetDir);
    }
  };

  const handleExportCustomMix = async () => {
    const active = tracks
      .filter((t) => (anySolo ? t.solo && !t.muted : !t.muted) && t.volume > 0)
      .map((t) => ({ path: t.path, volume: t.volume * masterVolume }));

    if (active.length === 0) {
      setErrorMsg('내보낼 활성 트랙이 없습니다. 최소 1개 트랙의 음소거를 해제하세요.');
      return;
    }

    const base = inputPath ? inputPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') : 'mix';
    const res = await window.musicSplitter.exportCustomMix({
      stems: active,
      format,
      defaultName: base || 'mix'
    });
    if (res.ok) showToast('커스텀 믹스 내보내기 완료!');
    else if (res.error) setErrorMsg(res.error);
  };

  const fileName = inputPath ? inputPath.split(/[\\/]/).pop() : null;
  const playProgress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <div className="h-screen w-screen flex flex-col bg-daw-bg text-zinc-100 select-none">
      {/* Top Transport Bar (Logic Pro Style) */}
      <header className="h-14 shrink-0 px-5 bg-daw-panel border-b border-daw-border flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shadow-md shadow-blue-500/20">
            <Layers className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white flex items-center gap-2">
              MusicSplitter
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/30">
                AI Stem Splitter
              </span>
            </h1>
            <p className="text-[11px] text-zinc-400">
              Logic Pro 스타일 멀티트랙 보컬 · 악기 분리 DAW
            </p>
          </div>
        </div>

        {/* Center Transport Controls */}
        <div className="flex items-center gap-3 bg-[#12141a] px-4 py-1.5 rounded-xl border border-daw-border">
          <button
            onClick={handleStop}
            disabled={tracks.length === 0}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
            title="정지 (Stop)"
          >
            <Square className="w-4 h-4 fill-current" />
          </button>
          <button
            onClick={handleTogglePlay}
            disabled={tracks.length === 0}
            className="w-8 h-8 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white flex items-center justify-center transition-colors shadow-sm"
            title={isPlaying ? '일시정지' : '재생'}
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 fill-current" />
            ) : (
              <Play className="w-4 h-4 fill-current ml-0.5" />
            )}
          </button>

          <div className="px-3 py-1 rounded bg-[#0c0d11] border border-daw-border/80 font-mono text-xs text-blue-400 min-w-[132px] text-center">
            {formatTime(currentTime)} <span className="text-zinc-600">/</span>{' '}
            <span className="text-zinc-400">{formatTime(duration)}</span>
          </div>

          <div className="flex items-center gap-2 pl-2 border-l border-daw-border">
            <Volume2 className="w-3.5 h-3.5 text-zinc-400" />
            <input
              type="range"
              min={0}
              max={1.2}
              step={0.01}
              value={masterVolume}
              onChange={(e) => setMasterVolume(parseFloat(e.target.value))}
              className="daw-slider w-20"
              title="마스터 볼륨"
            />
          </div>
        </div>

        {/* Right Environment Status */}
        <div className="flex items-center gap-2">
          {envStatus?.ready ? (
            <button
              onClick={() => setSetupOpen(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs hover:bg-emerald-500/20 transition-colors"
              title="AI 엔진 및 GPU 설정 관리"
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>{envStatus.gpuName || 'CPU'}</span>
            </button>
          ) : (
            <button
              onClick={() => setSetupOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs hover:bg-amber-500/25 transition-colors"
            >
              <AlertCircle className="w-3.5 h-3.5" />
              <span>AI 엔진 설정 필요</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Sidebar: Source & Separation Settings */}
        <aside className="w-80 shrink-0 bg-daw-panel border-r border-daw-border p-4 flex flex-col gap-4 overflow-y-auto">
          {/* File Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={handleSelectFile}
            className={`rounded-xl border-2 border-dashed p-4 text-center cursor-pointer transition-all ${
              isDragging
                ? 'border-blue-500 bg-blue-500/10'
                : inputPath
                  ? 'border-daw-border bg-daw-surface/60 hover:border-zinc-500'
                  : 'border-zinc-700 bg-daw-surface/40 hover:border-blue-500/60 hover:bg-daw-surface'
            }`}
          >
            {inputPath ? (
              <div className="flex items-center gap-3 text-left">
                <div className="w-10 h-10 rounded-lg bg-blue-500/15 text-blue-400 flex items-center justify-center shrink-0">
                  <FileAudio className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-zinc-100 truncate" title={fileName || ''}>
                    {fileName}
                  </div>
                  {audioInfo && (
                    <div className="text-[11px] text-zinc-400 font-mono mt-0.5">
                      {audioInfo.formatName} · {Math.round(audioInfo.sampleRate / 1000)}kHz ·{' '}
                      {formatTime(audioInfo.duration)} · {formatBytes(audioInfo.sizeBytes)}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="py-3 flex flex-col items-center gap-2">
                <Upload className="w-7 h-7 text-blue-400" />
                <div className="text-sm font-medium text-zinc-200">
                  오디오 파일을 드래그하거나 클릭
                </div>
                <div className="text-[11px] text-zinc-400">
                  MP3, WAV, FLAC, OGG, M4A 지원
                </div>
              </div>
            )}
          </div>

          {/* Separation Mode */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300 uppercase tracking-wider">
              <Sliders className="w-3.5 h-3.5 text-blue-400" />
              <span>분리 모드 (Stem Mode)</span>
            </div>
            <div className="flex flex-col gap-2">
              {MODE_OPTIONS.map((opt) => {
                const selected = mode === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setMode(opt.id)}
                    disabled={isSeparating}
                    className={`text-left p-2.5 rounded-xl border transition-all ${
                      selected
                        ? 'bg-blue-600/15 border-blue-500/70 shadow-sm'
                        : 'bg-daw-surface/60 border-daw-border hover:border-zinc-600'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-zinc-100">{opt.title}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          selected
                            ? 'bg-blue-500 text-white'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {opt.badge}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">{opt.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Output Format */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
              출력 오디오 포맷
            </label>
            <div className="grid grid-cols-4 gap-1.5">
              {FORMAT_OPTIONS.map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => setFormat(fmt)}
                  disabled={isSeparating}
                  className={`py-1.5 rounded-lg text-xs font-mono font-semibold uppercase border transition-colors ${
                    format === fmt
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-daw-surface border-daw-border text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {fmt}
                </button>
              ))}
            </div>
          </div>

          {/* Action Button */}
          <div className="mt-auto pt-2 flex flex-col gap-2">
            {!isSeparating ? (
              <button
                onClick={handleStartSeparation}
                disabled={!inputPath || !envStatus?.ready}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-lg shadow-blue-600/20 transition-all"
              >
                <Sparkles className="w-4 h-4" />
                <span>AI 트랙 분리 시작</span>
              </button>
            ) : (
              <div className="p-3 rounded-xl bg-daw-surface border border-blue-500/40 flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-blue-400 font-medium flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    분리 진행 중...
                  </span>
                  <span className="font-mono text-zinc-300">{progress}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-blue-500 to-violet-500 transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="text-[11px] text-zinc-400 truncate">{progressMsg}</div>
                <button
                  onClick={handleCancelSeparation}
                  className="mt-1 py-1.5 rounded-lg bg-zinc-800 hover:bg-red-500/20 hover:text-red-400 text-xs text-zinc-300 transition-colors"
                >
                  취소
                </button>
              </div>
            )}
          </div>
        </aside>

        {/* Right Main Stem Mixer Area */}
        <main className="flex-1 flex flex-col min-w-0 bg-daw-bg">
          {/* Mixer Toolbar */}
          <div className="h-12 shrink-0 px-5 border-b border-daw-border flex items-center justify-between gap-3 bg-[#14161c]">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-400 mr-1">빠른 프리셋:</span>
              <button
                onClick={() => applyPreset('all')}
                disabled={tracks.length === 0}
                className="px-2.5 py-1 rounded-md text-xs bg-daw-surface hover:bg-daw-hover disabled:opacity-40 border border-daw-border text-zinc-200 transition-colors"
              >
                전체 트랙
              </button>
              <button
                onClick={() => applyPreset('vocals_only')}
                disabled={tracks.length === 0}
                className="px-2.5 py-1 rounded-md text-xs bg-daw-surface hover:bg-pink-500/15 hover:border-pink-500/40 disabled:opacity-40 border border-daw-border text-zinc-200 transition-colors"
              >
                보컬만 듣기
              </button>
              <button
                onClick={() => applyPreset('instrumental_only')}
                disabled={tracks.length === 0}
                className="px-2.5 py-1 rounded-md text-xs bg-daw-surface hover:bg-blue-500/15 hover:border-blue-500/40 disabled:opacity-40 border border-daw-border text-zinc-200 transition-colors"
              >
                MR(반주)만 듣기
              </button>
            </div>

            <div className="flex items-center gap-2">
              {sessionDir && (
                <button
                  onClick={() => window.musicSplitter.openFolder(sessionDir)}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-daw-surface hover:bg-daw-hover border border-daw-border text-zinc-300 flex items-center gap-1.5 transition-colors"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>작업 폴더</span>
                </button>
              )}
              <button
                onClick={handleExportCustomMix}
                disabled={tracks.length === 0}
                className="px-3 py-1.5 rounded-lg text-xs bg-daw-surface hover:bg-daw-hover disabled:opacity-40 border border-daw-border text-zinc-100 flex items-center gap-1.5 transition-colors"
              >
                <Download className="w-3.5 h-3.5 text-violet-400" />
                <span>현재 믹스 저장</span>
              </button>
              <button
                onClick={handleExportAll}
                disabled={tracks.length === 0}
                className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-medium flex items-center gap-1.5 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>모든 스템 내보내기</span>
              </button>
            </div>
          </div>

          {/* Error Banner */}
          {errorMsg && (
            <div className="mx-5 mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
              <button onClick={() => setErrorMsg(null)} className="text-red-400 hover:text-red-200">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Stem Tracks List */}
          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-3">
            {tracks.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500 gap-3">
                <div className="w-16 h-16 rounded-2xl bg-daw-panel border border-daw-border flex items-center justify-center">
                  <Layers className="w-8 h-8 text-zinc-600" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-zinc-300">
                    분리된 스템 트랙이 여기에 표시됩니다
                  </h2>
                  <p className="text-xs text-zinc-500 mt-1 max-w-md leading-relaxed">
                    왼쪽에서 MP3, WAV, FLAC, OGG 파일을 선택하고 분리 모드(2/4/6 Stems)를 고른 뒤
                    &quot;AI 트랙 분리 시작&quot;을 눌러주세요.
                  </p>
                </div>
              </div>
            ) : (
              tracks.map((track) => {
                const effectivelyMuted = anySolo ? !track.solo || track.muted : track.muted;
                return (
                  <StemTrackRow
                    key={track.id}
                    track={track}
                    effectivelyMuted={effectivelyMuted}
                    progress={playProgress}
                    onToggleMute={handleToggleMute}
                    onToggleSolo={handleToggleSolo}
                    onVolumeChange={handleVolumeChange}
                    onSeek={handleSeek}
                    onExportSingle={handleExportSingle}
                  />
                );
              })
            )}
          </div>
        </main>
      </div>

      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-medium shadow-xl flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* First-Run AI Engine Setup Modal */}
      {setupOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl bg-daw-panel border border-daw-border shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-bold text-white">AI 음원 분리 엔진 설정</h2>
                <p className="text-xs text-zinc-400 mt-1">
                  오프라인 고품질 트랙 분리를 위해 Meta Demucs &amp; PyTorch 환경을 구성합니다.
                </p>
                {envStatus?.venvDir && (
                  <p className="text-[11px] font-mono text-zinc-400 mt-1.5 bg-[#0c0d11] px-2.5 py-1 rounded border border-daw-border break-all">
                    설치 경로: {envStatus.venvDir}
                  </p>
                )}
              </div>
              {!setupRunning && (
                <button
                  onClick={() => setSetupOpen(false)}
                  className="text-zinc-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {setupError && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
                {setupError}
              </div>
            )}

            {setupLogs.length > 0 && (
              <div className="h-44 rounded-xl bg-[#0c0d11] border border-daw-border p-3 overflow-y-auto font-mono text-[11px] text-zinc-300 whitespace-pre-wrap">
                {setupLogs.join('\n')}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-2">
              <button
                onClick={handleResetEnvironment}
                disabled={setupRunning}
                className="px-3 py-2 rounded-lg text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/30 disabled:opacity-40"
              >
                기존 가상환경 삭제
              </button>
              <div className="flex items-center gap-2">
                {!setupRunning && (
                  <button
                    onClick={() => setSetupOpen(false)}
                    className="px-4 py-2 rounded-lg text-xs text-zinc-400 hover:text-white bg-daw-surface border border-daw-border"
                  >
                    닫기
                  </button>
                )}
                <button
                  onClick={handleRunSetup}
                  disabled={setupRunning}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white flex items-center gap-2"
                >
                  {setupRunning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{setupRunning ? '설치 진행 중...' : '원클릭 자동 설치 (GPU 지원)'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
