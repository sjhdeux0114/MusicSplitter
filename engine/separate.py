#!/usr/bin/env python3
"""
MusicSplitter AI Stem Separation Engine
Uses Meta Demucs (htdemucs / htdemucs_ft / htdemucs_6s) + FFmpeg + soundfile
for reliable cross-platform (Windows & macOS) offline stem separation.
Supports MP3, WAV, FLAC, OGG, M4A, AAC inputs and WAV/MP3/FLAC/OGG outputs.
"""

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np
import soundfile as sf
import torch


def emit(event: dict) -> None:
    """Print a JSON line event to stdout and flush immediately."""
    print(json.dumps(event, ensure_ascii=False), flush=True)


def detect_device(requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def convert_to_wav(ffmpeg_bin: str, input_path: str, wav_path: str, sample_rate: int = 44100) -> None:
    """Decode any audio format (mp3, wav, flac, ogg, m4a, etc.) to 32-bit float stereo WAV."""
    cmd = [
        ffmpeg_bin,
        "-y",
        "-i",
        input_path,
        "-vn",
        "-ac",
        "2",
        "-ar",
        str(sample_rate),
        "-c:a",
        "pcm_f32le",
        wav_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg decode failed: {proc.stderr[-500:]}")


def encode_audio(ffmpeg_bin: str, wav_path: str, out_path: str, fmt: str) -> None:
    """Encode WAV stem to target format (wav, mp3, flac, ogg)."""
    fmt = fmt.lower()
    if fmt == "wav":
        cmd = [ffmpeg_bin, "-y", "-i", wav_path, "-c:a", "pcm_s24le", out_path]
    elif fmt == "mp3":
        cmd = [ffmpeg_bin, "-y", "-i", wav_path, "-c:a", "libmp3lame", "-b:a", "320k", out_path]
    elif fmt == "flac":
        cmd = [ffmpeg_bin, "-y", "-i", wav_path, "-c:a", "flac", "-compression_level", "5", out_path]
    elif fmt == "ogg":
        cmd = [ffmpeg_bin, "-y", "-i", wav_path, "-c:a", "libvorbis", "-q:a", "8", out_path]
    else:
        raise ValueError(f"Unsupported output format: {fmt}")

    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg encode failed ({fmt}): {proc.stderr[-500:]}")


class TqdmProgressCapture(io.TextIOBase):
    """Intercepts Demucs tqdm stderr output and emits JSON progress events."""

    def __init__(self, orig_stderr):
        super().__init__()
        self.orig_stderr = orig_stderr
        self._buf = ""
        self._last_pct = -1

    def write(self, s: str) -> int:
        self._buf += s
        # Match percentages like " 45%|" or "100%|"
        matches = re.findall(r"(\d{1,3})%\|", self._buf)
        if matches:
            pct = min(100, max(0, int(matches[-1])))
            if pct != self._last_pct:
                self._last_pct = pct
                # Map model separation to 15%..88% of overall pipeline
                overall = 15 + int(pct * 0.73)
                emit(
                    {
                        "type": "progress",
                        "percent": overall,
                        "stage": "separating",
                        "message": f"AI 모델 트랙 분리 중... ({pct}%)",
                    }
                )
        if "\n" in self._buf or "\r" in self._buf:
            self._buf = self._buf[-120:]
        return len(s)

    def flush(self) -> None:
        pass


def separate_audio(args: argparse.Namespace) -> None:
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    mode_map = {
        "2stems": ("htdemucs", True),
        "4stems": ("htdemucs", False),
        "4stems_hq": ("htdemucs_ft", False),
        "6stems": ("htdemucs_6s", False),
    }
    if args.mode not in mode_map:
        raise ValueError(f"Invalid mode: {args.mode}")

    model_name, two_stems_vocals = mode_map[args.mode]
    device = detect_device(args.device)

    emit(
        {
            "type": "progress",
            "percent": 5,
            "stage": "loading_model",
            "message": f"AI 모델({model_name}) 로드 중... (장치: {device.upper()})",
        }
    )

    model = get_model(model_name)
    model.to(device)
    model.eval()
    sample_rate = model.samplerate  # typically 44100

    with tempfile.TemporaryDirectory(prefix="musicsplitter_") as tmp_dir:
        tmp_wav = os.path.join(tmp_dir, "input_44k.wav")

        emit(
            {
                "type": "progress",
                "percent": 10,
                "stage": "decoding",
                "message": "오디오 파일 디코딩 및 전처리 중...",
            }
        )
        convert_to_wav(args.ffmpeg, str(input_path), tmp_wav, sample_rate=sample_rate)

        audio_np, sr = sf.read(tmp_wav, dtype="float32", always_2d=True)
        # shape: (samples, channels) -> (1, channels, samples)
        wav_tensor = torch.from_numpy(audio_np.T).unsqueeze(0)

        # Normalize using Demucs convention
        ref = wav_tensor.mean(0)
        wav_norm = (wav_tensor - ref.mean()) / (ref.std() + 1e-8)

        emit(
            {
                "type": "progress",
                "percent": 15,
                "stage": "separating",
                "message": "AI 음원 분리 시작...",
            }
        )

        orig_stderr = sys.stderr
        sys.stderr = TqdmProgressCapture(orig_stderr)
        try:
            with torch.no_grad():
                sources = apply_model(
                    model,
                    wav_norm,
                    device=device,
                    shifts=1,
                    split=True,
                    overlap=0.25,
                    progress=True,
                )
        finally:
            sys.stderr = orig_stderr

        sources = sources * (ref.std() + 1e-8) + ref.mean()
        sources = sources.squeeze(0).cpu().numpy()  # (num_stems, channels, samples)

        stem_names = list(model.sources)
        stem_outputs = {}
        for idx, name in enumerate(stem_names):
            stem_outputs[name] = sources[idx]

        if two_stems_vocals:
            vocals = stem_outputs["vocals"]
            instrumental = np.zeros_like(vocals)
            for name, data in stem_outputs.items():
                if name != "vocals":
                    instrumental += data
            final_stems = [
                ("vocals", "Vocals", vocals),
                ("instrumental", "Instrumental", instrumental),
            ]
        else:
            label_map = {
                "vocals": "Vocals",
                "drums": "Drums",
                "bass": "Bass",
                "guitar": "Guitar",
                "piano": "Piano",
                "other": "Other",
            }
            final_stems = [
                (name, label_map.get(name, name.capitalize()), stem_outputs[name])
                for name in stem_names
            ]

        emit(
            {
                "type": "progress",
                "percent": 90,
                "stage": "encoding",
                "message": f"트랙을 {args.format.upper()} 형식으로 저장 중...",
            }
        )

        results = []
        base_name = input_path.stem
        total = len(final_stems)
        for i, (stem_id, stem_label, data) in enumerate(final_stems):
            # Clip to prevent digital clipping
            clipped = np.clip(data.T, -1.0, 1.0)
            raw_stem_wav = os.path.join(tmp_dir, f"{stem_id}.wav")
            sf.write(raw_stem_wav, clipped, sample_rate, subtype="FLOAT")

            out_filename = f"{base_name}_{stem_id}.{args.format.lower()}"
            out_path = str(output_dir / out_filename)
            encode_audio(args.ffmpeg, raw_stem_wav, out_path, args.format)

            results.append(
                {
                    "id": stem_id,
                    "name": stem_label,
                    "path": out_path,
                    "format": args.format.lower(),
                }
            )
            pct = 90 + int(((i + 1) / total) * 10)
            emit(
                {
                    "type": "progress",
                    "percent": min(99, pct),
                    "stage": "encoding",
                    "message": f"{stem_label} 저장 완료",
                }
            )

        emit({"type": "done", "stems": results, "device": device, "model": model_name})


def main() -> None:
    parser = argparse.ArgumentParser(description="MusicSplitter AI Stem Separation Engine")
    parser.add_argument("--input", required=True, help="Input audio file path")
    parser.add_argument("--output-dir", required=True, help="Output directory for stems")
    parser.add_argument(
        "--mode",
        default="4stems",
        choices=["2stems", "4stems", "4stems_hq", "6stems"],
        help="Stem separation mode",
    )
    parser.add_argument(
        "--format",
        default="wav",
        choices=["wav", "mp3", "flac", "ogg"],
        help="Output audio format",
    )
    parser.add_argument("--ffmpeg", default="ffmpeg", help="Path to ffmpeg executable")
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "cuda", "mps"],
        help="Compute device",
    )
    args = parser.parse_args()

    try:
        separate_audio(args)
    except Exception as exc:
        emit({"type": "error", "message": str(exc), "traceback": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
