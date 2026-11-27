import React from 'react';
import {
  Download,
  Drum,
  Guitar,
  Mic,
  Music,
  Piano,
  Radio,
  Volume2,
  VolumeX
} from 'lucide-react';
import { StemTrackState } from '../types';
import { WaveformCanvas } from './WaveformCanvas';

interface StemTrackRowProps {
  track: StemTrackState;
  effectivelyMuted: boolean;
  progress: number;
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
  onVolumeChange: (id: string, volume: number) => void;
  onSeek: (ratio: number) => void;
  onExportSingle: (track: StemTrackState) => void;
}

function getStemIcon(id: string) {
  switch (id) {
    case 'vocals':
      return <Mic className="w-4 h-4" />;
    case 'drums':
      return <Drum className="w-4 h-4" />;
    case 'bass':
      return <Radio className="w-4 h-4" />;
    case 'guitar':
      return <Guitar className="w-4 h-4" />;
    case 'piano':
      return <Piano className="w-4 h-4" />;
    default:
      return <Music className="w-4 h-4" />;
  }
}

function getKoreanLabel(id: string, fallback: string): string {
  const map: Record<string, string> = {
    vocals: '보컬 (Vocals)',
    instrumental: '반주 (Instrumental)',
    drums: '드럼 (Drums)',
    bass: '베이스 (Bass)',
    guitar: '기타 (Guitar)',
    piano: '피아노 (Piano)',
    other: '기타 악기 (Other)'
  };
  return map[id] || fallback;
}

export const StemTrackRow: React.FC<StemTrackRowProps> = ({
  track,
  effectivelyMuted,
  progress,
  onToggleMute,
  onToggleSolo,
  onVolumeChange,
  onSeek,
  onExportSingle
}) => {
  const volPercent = Math.round(track.volume * 100);

  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
        effectivelyMuted
          ? 'bg-[#16181e]/70 border-daw-border/50 opacity-75'
          : 'bg-daw-panel border-daw-border hover:border-zinc-600/80'
      }`}
    >
      {/* Left Track Header (Logic Pro style) */}
      <div className="w-64 shrink-0 flex flex-col gap-2 pr-2 border-r border-daw-border/60">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-white shadow-sm"
              style={{ backgroundColor: track.color }}
            >
              {getStemIcon(track.id)}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-zinc-100 truncate">
                {getKoreanLabel(track.id, track.name)}
              </div>
              <div className="text-[11px] text-zinc-400 uppercase font-mono">
                {track.format}
              </div>
            </div>
          </div>

          <button
            onClick={() => onExportSingle(track)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-daw-hover transition-colors"
            title="이 트랙만 저장"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>

        {/* M / S / Volume Fader */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onToggleMute(track.id)}
            className={`w-7 h-6 rounded text-xs font-bold transition-colors ${
              track.muted
                ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30'
                : 'bg-daw-surface text-zinc-400 hover:text-zinc-200 border border-daw-border'
            }`}
            title="음소거 (Mute)"
          >
            M
          </button>
          <button
            onClick={() => onToggleSolo(track.id)}
            className={`w-7 h-6 rounded text-xs font-bold transition-colors ${
              track.solo
                ? 'bg-amber-500 text-zinc-950 shadow-sm shadow-amber-500/30'
                : 'bg-daw-surface text-zinc-400 hover:text-zinc-200 border border-daw-border'
            }`}
            title="솔로 (Solo)"
          >
            S
          </button>

          <div className="flex items-center gap-1.5 flex-1 ml-1">
            {track.volume === 0 || effectivelyMuted ? (
              <VolumeX className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            ) : (
              <Volume2 className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            )}
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.01}
              value={track.volume}
              onChange={(e) => onVolumeChange(track.id, parseFloat(e.target.value))}
              className="daw-slider flex-1"
            />
            <span className="text-[11px] font-mono text-zinc-400 w-9 text-right">
              {volPercent}%
            </span>
          </div>
        </div>
      </div>

      {/* Right Waveform Lane */}
      <div className="flex-1 min-w-0">
        <WaveformCanvas
          peaks={track.peaks}
          color={track.color}
          progress={progress}
          muted={effectivelyMuted}
          onSeek={onSeek}
        />
      </div>
    </div>
  );
};
