import React, { useEffect, useRef } from 'react';

interface WaveformCanvasProps {
  peaks: number[];
  color: string;
  progress: number; // 0 to 1
  muted: boolean;
  onSeek: (ratio: number) => void;
}

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  peaks,
  color,
  progress,
  muted,
  onSeek
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const midY = height / 2;
    const barCount = peaks.length || 1;
    const step = width / barCount;
    const barWidth = Math.max(1.5, step * 0.68);
    const playheadX = progress * width;

    // Center reference line
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    for (let i = 0; i < barCount; i++) {
      const x = i * step;
      const amp = Math.max(0.03, Math.min(1, peaks[i] || 0));
      const barH = amp * (height * 0.84);
      const isPlayed = x <= playheadX;

      ctx.fillStyle = muted
        ? 'rgba(113, 113, 122, 0.3)'
        : isPlayed
          ? color
          : `${color}66`;

      const y = midY - barH / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barH, 1.5);
      ctx.fill();
    }

    // Playhead line
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }, [peaks, color, progress, muted]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(ratio);
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      className="w-full h-16 cursor-pointer rounded-md bg-[#13151a] border border-daw-border/60 hover:border-zinc-600 transition-colors"
      title="클릭하여 위치 이동"
    />
  );
};
