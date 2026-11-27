#!/usr/bin/env python3
"""
MusicSplitter Audio-to-MIDI Conversion Engine (v3 - Studio Precision)
Converts separated audio stems (vocals, bass, guitar, piano, drums, other, instrumental)
into Standard MIDI Files (.mid) using PyTorch + NumPy + soundfile.

Key v3 enhancements:
- 3-bins-per-semitone (36 bins/octave, 33-cent) Constant-Q filterbank for crisp pitch separation
- Spectral whitening (local pitch-median subtraction) to remove reverb/mud bleed
- Dual-threshold hysteresis (onset vs sustain) + chord-change decay-tail trimming
- Monophonic Viterbi tracking + vibrato-safe note merging (vocals, bass)
- Krumhansl-Schmuckler key estimation to prune weak out-of-key chromatic bleed
- Phase-aligned BPM & smart rhythmic quantization (1/16th grid)
- 6-piece GM drum transcription with beat-locked transients
"""

import argparse
import json
import math
import struct
import sys
import traceback
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F


STEM_CONFIG: Dict[str, dict] = {
    "vocals": {
        "program": 52,  # Choir Aahs
        "channel": 0,
        "min_midi": 45,  # A2
        "max_midi": 84,  # C6
        "mode": "mono",
        "min_dur": 0.075,
        "onset_db": -22.0,
        "sustain_db": -30.0,
        "jump_penalty": 0.09,
        "quantize": 0.55,
    },
    "bass": {
        "program": 33,  # Electric Bass (finger)
        "channel": 1,
        "min_midi": 24,  # C1
        "max_midi": 60,  # C4
        "mode": "mono",
        "min_dur": 0.065,
        "onset_db": -22.0,
        "sustain_db": -30.0,
        "jump_penalty": 0.11,
        "quantize": 0.75,
    },
    "guitar": {
        "program": 25,  # Acoustic Guitar (steel)
        "channel": 2,
        "min_midi": 40,  # E2
        "max_midi": 84,  # C6
        "mode": "poly",
        "min_dur": 0.06,
        "onset_db": -20.0,
        "sustain_db": -28.0,
        "max_poly": 6,
        "quantize": 0.70,
    },
    "piano": {
        "program": 0,  # Acoustic Grand Piano
        "channel": 3,
        "min_midi": 21,  # A0
        "max_midi": 108,  # C8
        "mode": "poly",
        "min_dur": 0.055,
        "onset_db": -20.0,
        "sustain_db": -28.0,
        "max_poly": 8,
        "quantize": 0.72,
    },
    "other": {
        "program": 48,  # String Ensemble 1
        "channel": 4,
        "min_midi": 36,  # C2
        "max_midi": 96,  # C7
        "mode": "poly",
        "min_dur": 0.07,
        "onset_db": -21.0,
        "sustain_db": -29.0,
        "max_poly": 6,
        "quantize": 0.65,
    },
    "instrumental": {
        "program": 0,  # Acoustic Grand Piano
        "channel": 5,
        "min_midi": 24,  # C1
        "max_midi": 100,  # E7
        "mode": "poly",
        "min_dur": 0.055,
        "onset_db": -20.0,
        "sustain_db": -28.0,
        "max_poly": 8,
        "quantize": 0.70,
    },
    "drums": {
        "program": 0,
        "channel": 9,  # GM Drum Channel (10 in 1-indexed)
        "min_midi": 35,
        "max_midi": 81,
        "mode": "drums",
        "min_dur": 0.04,
        "quantize": 0.80,
    },
}

# Krumhansl-Schmuckler key profiles
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_MAJOR_SCALE = {0, 2, 4, 5, 7, 9, 11}
_MINOR_SCALE = {0, 2, 3, 5, 7, 8, 10}


def emit(event: dict) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def load_mono_audio(path: str, target_sr: int = 22050) -> Tuple[torch.Tensor, int]:
    """Load audio file as mono float32 tensor resampled to target_sr."""
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    wav = torch.from_numpy(mono).unsqueeze(0).unsqueeze(0)
    if sr != target_sr:
        import torchaudio

        wav = torchaudio.functional.resample(wav.squeeze(0), sr, target_sr).unsqueeze(0)
    return wav, target_sr


def estimate_tempo_and_phase(onset_env: np.ndarray, fps: float) -> Tuple[float, float]:
    """
    Estimate BPM in [68, 172] and downbeat phase offset (seconds)
    from an onset strength envelope.
    """
    if len(onset_env) < int(fps * 4):
        return 120.0, 0.0
    env = onset_env - np.mean(onset_env)
    norm = np.linalg.norm(env)
    if norm < 1e-8:
        return 120.0, 0.0

    acf = np.correlate(env, env, mode="full")[len(env) - 1 :]
    acf = acf / (acf[0] + 1e-8)

    best_bpm = 120.0
    best_score = -1e9
    for bpm in np.arange(68.0, 172.5, 0.5):
        lag = int(round(60.0 * fps / bpm))
        if lag >= len(acf):
            continue
        score = acf[lag]
        if 2 * lag < len(acf):
            score += 0.55 * acf[2 * lag]
        if lag // 2 > 0:
            score += 0.25 * acf[lag // 2]
        prior = 1.0 - 0.14 * abs(bpm - 116.0) / 60.0
        weighted = score * prior
        if weighted > best_score:
            best_score = weighted
            best_bpm = float(bpm)

    # Find best beat phase offset in [0, beat_period)
    beat_sec = 60.0 / best_bpm
    beat_frames = max(4, int(round(beat_sec * fps)))
    best_phase_f = 0
    best_phase_energy = -1.0
    pos_env = np.maximum(0.0, onset_env)
    for ph in range(beat_frames):
        energy = float(np.sum(pos_env[ph::beat_frames]))
        if energy > best_phase_energy:
            best_phase_energy = energy
            best_phase_f = ph

    return round(best_bpm, 1), best_phase_f / fps


def build_fine_cqt_filterbank(
    sr: int, min_midi: int, max_midi: int, bins_per_semitone: int = 3, kernel_len: int = 4096
) -> Tuple[torch.Tensor, torch.Tensor]:
    """
    Build normalized complex Hann-windowed DFT kernels at 1/3-semitone resolution
    (bins_per_semitone=3 -> 36 bins/octave) for sharp pitch localization.
    """
    n_notes = max_midi - min_midi + 1
    total_bins = n_notes * bins_per_semitone
    k_real = torch.zeros((total_bins, 1, kernel_len), dtype=torch.float32)
    k_imag = torch.zeros((total_bins, 1, kernel_len), dtype=torch.float32)

    q = 1.0 / (2.0 ** (1.0 / 12.0) - 1.0)  # ~16.82, slightly sharper for 3-bin resolution
    offsets = np.linspace(-1.0 / 3.0, 1.0 / 3.0, bins_per_semitone)

    idx = 0
    for midi in range(min_midi, max_midi + 1):
        for off in offsets:
            freq = 440.0 * (2.0 ** ((midi + off - 69.0) / 12.0))
            win_len = int(round(q * sr / freq))
            win_len = max(256, min(kernel_len, win_len))
            if win_len % 2 == 1:
                win_len -= 1

            t = torch.arange(win_len, dtype=torch.float32) - (win_len - 1) / 2.0
            window = torch.hann_window(win_len, periodic=False)
            window = window / (window.sum() + 1e-8) * 2.0

            phase = 2.0 * math.pi * freq * t / sr
            start = (kernel_len - win_len) // 2
            k_real[idx, 0, start : start + win_len] = window * torch.cos(phase)
            k_imag[idx, 0, start : start + win_len] = window * torch.sin(phase)
            idx += 1

    return k_real, k_imag


def compute_semitone_cqt(
    wav: torch.Tensor, sr: int, min_midi: int, max_midi: int, hop_length: int = 256
) -> np.ndarray:
    """
    Compute 1/3-semitone CQT and pool each semitone's 3 sub-bins (center-weighted max)
    to return a clean (n_notes, n_frames) magnitude matrix.
    """
    bins_per_st = 3
    kernel_len = 4096
    k_real, k_imag = build_fine_cqt_filterbank(
        sr, min_midi, max_midi, bins_per_semitone=bins_per_st, kernel_len=kernel_len
    )
    device = wav.device
    k_real = k_real.to(device)
    k_imag = k_imag.to(device)

    pad = kernel_len // 2
    with torch.no_grad():
        re = F.conv1d(wav, k_real, stride=hop_length, padding=pad)
        im = F.conv1d(wav, k_imag, stride=hop_length, padding=pad)
        mag_fine = torch.sqrt(re * re + im * im + 1e-12).squeeze(0)  # (n_notes*3, n_frames)

    n_notes = max_midi - min_midi + 1
    mag_3 = mag_fine.view(n_notes, bins_per_st, -1)
    # Slightly prefer center bin over +/-33-cent side bins to reduce cross-semitone bleed
    weights = torch.tensor([0.92, 1.0, 0.92], device=device).view(1, 3, 1)
    mag_semitone = torch.max(mag_3 * weights, dim=1).values
    return mag_semitone.cpu().numpy()


def whiten_spectrogram(mag_norm: np.ndarray) -> np.ndarray:
    """
    Subtract local pitch-axis median background (spectral whitening) so broadband
    reverb/mud doesn't sustain false bass/mid notes.
    """
    n_notes, n_frames = mag_norm.shape
    if n_notes < 12:
        return mag_norm
    whitened = np.empty_like(mag_norm)
    half_w = 7  # 15-semitone window
    for i in range(n_notes):
        lo = max(0, i - half_w)
        hi = min(n_notes, i + half_w + 1)
        bg = np.median(mag_norm[lo:hi, :], axis=0)
        whitened[i, :] = np.maximum(0.0, mag_norm[i, :] - 0.65 * bg)
    return whitened


def compute_adaptive_envelope(mag_norm: np.ndarray, fps: float) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (local_rms, flux_db, global_onset_flux)."""
    frame_rms = np.sqrt(np.mean(mag_norm ** 2, axis=0) + 1e-12)
    win = max(5, int(round(1.4 * fps)))
    if win % 2 == 0:
        win += 1
    kernel = np.ones(win, dtype=np.float32) / win
    local_rms = np.maximum(np.convolve(frame_rms, kernel, mode="same"), 0.025)

    mag_db = 20.0 * np.log10(mag_norm + 1e-5)
    flux_db = np.maximum(0.0, np.diff(mag_db, axis=1, prepend=mag_db[:, :1]))
    global_flux = np.maximum(0.0, np.diff(mag_norm, axis=1, prepend=mag_norm[:, :1])).sum(axis=0)
    return local_rms, flux_db, global_flux


def viterbi_mono_track(
    salience: np.ndarray,
    mag_db: np.ndarray,
    flux_db: np.ndarray,
    sustain_db: float,
    jump_penalty: float,
) -> np.ndarray:
    """Viterbi dynamic programming for smooth monophonic pitch tracking."""
    n_notes, n_frames = salience.shape
    sal_norm = salience / (np.max(salience) + 1e-8)

    dp = np.zeros((n_notes, n_frames), dtype=np.float32)
    back = np.zeros((n_notes, n_frames), dtype=np.int32)
    dp[:, 0] = sal_norm[:, 0]

    idx_grid = np.arange(n_notes)[:, None]
    dist = np.abs(idx_grid - idx_grid.T)
    trans_pen = np.where(
        dist <= 2,
        dist * (jump_penalty * 0.22),
        jump_penalty * np.minimum(dist, 12) * 0.65,
    )

    frame_onset = np.max(flux_db, axis=0)

    for t in range(1, n_frames):
        onset_relax = 0.22 if frame_onset[t] > 5.5 else 1.0
        scores = dp[:, t - 1 : t] - (trans_pen * onset_relax)
        best_prev = np.argmax(scores, axis=0)
        dp[:, t] = scores[best_prev, np.arange(n_notes)] + sal_norm[:, t]
        back[:, t] = best_prev

    path = np.zeros(n_frames, dtype=np.int32)
    path[-1] = int(np.argmax(dp[:, -1]))
    for t in range(n_frames - 1, 0, -1):
        path[t - 1] = back[path[t], t]

    out = np.full(n_frames, -1, dtype=np.int32)
    for t in range(n_frames):
        p = path[t]
        if mag_db[p, t] > sustain_db:
            out[t] = p
    return out


def smooth_mono_vibrato(
    notes: List[Tuple[float, float, int, int]]
) -> List[Tuple[float, float, int, int]]:
    """
    Merge tiny 1-semitone vibrato/slide fragments in monophonic tracks
    when sandwiched inside a longer sustained note of the same base pitch.
    """
    if len(notes) < 3:
        return notes
    notes = sorted(notes, key=lambda x: x[0])
    merged: List[Tuple[float, float, int, int]] = []
    i = 0
    while i < len(notes):
        if (
            i + 2 < len(notes)
            and notes[i][2] == notes[i + 2][2]
            and abs(notes[i + 1][2] - notes[i][2]) == 1
            and (notes[i + 1][1] - notes[i + 1][0]) < 0.09
            and (notes[i + 1][0] - notes[i][1]) < 0.03
            and (notes[i + 2][0] - notes[i + 1][1]) < 0.03
        ):
            s = notes[i][0]
            e = notes[i + 2][1]
            p = notes[i][2]
            v = max(notes[i][3], notes[i + 2][3])
            merged.append((s, e, p, v))
            i += 3
        else:
            merged.append(notes[i])
            i += 1
    return merged


def extract_notes_hysteresis(
    onset_active: np.ndarray,
    sustain_active: np.ndarray,
    vel_grid: np.ndarray,
    flux_db: np.ndarray,
    global_flux: np.ndarray,
    mag_db: np.ndarray,
    min_midi: int,
    fps: float,
    min_dur: float,
    trim_on_chord: bool = False,
) -> List[Tuple[float, float, int, int]]:
    """
    Extract notes using dual-threshold hysteresis:
    - Requires onset_active (higher threshold) to START a note
    - Uses sustain_active (lower threshold) to HOLD a note
    - Splits repeated notes on strong per-pitch flux peaks
    - Optionally trims decaying tails when a strong new chord onset occurs
    """
    n_notes, n_frames = sustain_active.shape
    min_frames = max(2, int(round(min_dur * fps)))
    min_reartic_frames = max(3, int(round(0.08 * fps)))
    chord_flux_thresh = float(np.percentile(global_flux, 88)) if n_frames > 10 else 1e9

    notes: List[Tuple[float, float, int, int]] = []

    for idx in range(n_notes):
        row_sus = sustain_active[idx, :].copy()
        row_on = onset_active[idx, :]
        # Bridge 1-2 frame sustain dropouts
        for t in range(1, n_frames - 2):
            if not row_sus[t] and row_sus[t - 1] and (row_sus[t + 1] or row_sus[t + 2]):
                row_sus[t] = True

        midi_pitch = min_midi + idx
        in_note = False
        start_t = 0
        peak_db = -120.0
        f_col = flux_db[idx, :]

        for t in range(n_frames):
            if not in_note:
                if row_on[t] and row_sus[t]:
                    in_note = True
                    start_t = t
                    peak_db = float(mag_db[idx, t])
            else:
                peak_db = max(peak_db, float(mag_db[idx, t]))
                should_cut = not row_sus[t]
                # Trim decaying tail if a strong new chord hits and this note already decayed >10 dB
                if (
                    trim_on_chord
                    and not should_cut
                    and (t - start_t) >= min_frames
                    and global_flux[t] > chord_flux_thresh
                    and f_col[t] < 3.0
                    and (peak_db - float(mag_db[idx, t])) > 10.0
                ):
                    should_cut = True

                if should_cut:
                    in_note = False
                    if t - start_t >= min_frames:
                        peak_vel = int(np.max(vel_grid[idx, start_t:t])) or 75
                        notes.append((start_t / fps, t / fps, midi_pitch, peak_vel))
                elif (
                    (t - start_t) >= min_reartic_frames
                    and f_col[t] >= 7.0
                    and (t + 1 >= n_frames or f_col[t] >= f_col[t + 1])
                    and (f_col[t] >= f_col[t - 1])
                ):
                    # Split repeated note
                    peak_vel = int(np.max(vel_grid[idx, start_t:t])) or 75
                    notes.append((start_t / fps, max((start_t + 1) / fps, (t - 0.5) / fps), midi_pitch, peak_vel))
                    start_t = t
                    peak_db = float(mag_db[idx, t])

        if in_note and (n_frames - start_t >= min_frames):
            peak_vel = int(np.max(vel_grid[idx, start_t:n_frames])) or 75
            notes.append((start_t / fps, n_frames / fps, midi_pitch, peak_vel))

    return notes


def prune_ghost_notes(
    notes: List[Tuple[float, float, int, int]]
) -> List[Tuple[float, float, int, int]]:
    """Remove adjacent-semitone bleed (+/-1 st) and weak simultaneous octave ghosts."""
    if len(notes) < 2:
        return notes
    notes_sorted = sorted(notes, key=lambda x: (x[0], -x[3]))
    keep = [True] * len(notes_sorted)

    for i in range(len(notes_sorted)):
        if not keep[i]:
            continue
        s1, e1, p1, v1 = notes_sorted[i]
        for j in range(i + 1, len(notes_sorted)):
            if not keep[j]:
                continue
            s2, e2, p2, v2 = notes_sorted[j]
            if s2 - s1 > 0.03:
                break
            diff = abs(p2 - p1)
            if diff == 1 and v2 < v1 * 0.78 and (e2 - s2) < (e1 - s1) * 1.15:
                keep[j] = False
            elif p2 > p1 and (p2 - p1) in (12, 19, 24) and v2 < v1 * 0.48:
                keep[j] = False

    return [n for n, k in zip(notes_sorted, keep) if k]


def estimate_scale_and_prune(
    notes: List[Tuple[float, float, int, int]]
) -> List[Tuple[float, float, int, int]]:
    """
    Estimate diatonic key using Krumhansl-Schmuckler pitch-class histogram,
    then prune very short (<95 ms) & weak (<65 vel) out-of-scale chromatic artifacts.
    """
    if len(notes) < 12:
        return notes

    pc_weights = np.zeros(12, dtype=np.float64)
    for s, e, p, v in notes:
        pc_weights[p % 12] += max(0.02, e - s) * (v / 127.0)

    if np.sum(pc_weights) < 1e-6:
        return notes

    best_corr = -1e9
    best_scale = _MAJOR_SCALE
    for root in range(12):
        maj_rot = np.roll(_MAJOR_PROFILE, root)
        min_rot = np.roll(_MINOR_PROFILE, root)
        c_maj = float(np.corrcoef(pc_weights, maj_rot)[0, 1])
        c_min = float(np.corrcoef(pc_weights, min_rot)[0, 1])
        if c_maj > best_corr:
            best_corr = c_maj
            best_scale = {(root + iv) % 12 for iv in _MAJOR_SCALE}
        if c_min > best_corr:
            best_corr = c_min
            best_scale = {(root + iv) % 12 for iv in _MINOR_SCALE}

    # Only filter if key correlation is reasonably confident
    if best_corr < 0.45:
        return notes

    filtered = []
    for s, e, p, v in notes:
        dur = e - s
        if (p % 12) not in best_scale and dur < 0.095 and v < 68:
            continue
        filtered.append((s, e, p, v))
    return filtered


def smart_quantize_notes(
    notes: List[Tuple[float, float, int, int]],
    bpm: float,
    phase_sec: float,
    strength: float = 0.7,
) -> List[Tuple[float, float, int, int]]:
    """
    Gently pull note onset times toward the nearest 1/16th note grid line
    when within 38 ms, keeping natural musical feel while cleaning DAW piano roll.
    """
    if not notes or strength <= 0.0:
        return notes
    grid_step = (60.0 / max(40.0, bpm)) / 4.0  # 1/16th note in seconds
    max_snap_dist = min(0.038, grid_step * 0.45)

    out: List[Tuple[float, float, int, int]] = []
    for s, e, p, v in notes:
        dur = max(0.03, e - s)
        rel = s - phase_sec
        nearest = round(rel / grid_step) * grid_step + phase_sec
        dist = abs(nearest - s)
        if dist <= max_snap_dist and nearest >= 0.0:
            new_s = s + (nearest - s) * strength
        else:
            new_s = s
        out.append((max(0.0, new_s), max(new_s + 0.03, new_s + dur), p, v))
    return out


def transcribe_pitched_stem(
    wav: torch.Tensor, sr: int, cfg: dict
) -> Tuple[List[Tuple[float, float, int, int]], float]:
    """Transcribe a pitched stem (vocals, bass, guitar, piano, other, instrumental)."""
    hop_length = 256  # 11.6 ms resolution
    fps = sr / hop_length
    min_midi = cfg["min_midi"]
    max_midi = cfg["max_midi"]
    mode = cfg["mode"]
    min_dur = cfg["min_dur"]
    onset_db = cfg["onset_db"]
    sustain_db = cfg["sustain_db"]

    mag_raw = compute_semitone_cqt(wav, sr, min_midi, max_midi, hop_length=hop_length)
    n_notes, n_frames = mag_raw.shape
    if n_frames < 4:
        return [], 120.0

    global_max = float(np.max(mag_raw))
    if global_max < 1e-5:
        return [], 120.0

    mag_norm = mag_raw / (global_max + 1e-8)
    mag_white = whiten_spectrogram(mag_norm)
    mag_white_norm = mag_white / (float(np.max(mag_white)) + 1e-8)

    mag_db = 20.0 * np.log10(mag_norm + 1e-5)
    local_rms, flux_db, global_flux = compute_adaptive_envelope(mag_norm, fps)
    bpm, phase_sec = estimate_tempo_and_phase(global_flux, fps)

    onset_active = np.zeros_like(mag_norm, dtype=bool)
    sustain_active = np.zeros_like(mag_norm, dtype=bool)
    vel_grid = np.zeros_like(mag_norm, dtype=np.int32)

    if mode == "mono":
        salience = mag_white_norm.copy()
        for shift, weight in [(12, 0.45), (19, 0.22), (24, 0.12)]:
            if shift < n_notes:
                salience[:-shift, :] += weight * mag_white_norm[shift:, :]
        if 12 < n_notes:
            salience[12:, :] = np.maximum(0.0, salience[12:, :] - 0.35 * mag_white_norm[:-12, :])

        track = viterbi_mono_track(
            salience,
            mag_db,
            flux_db,
            sustain_db=sustain_db,
            jump_penalty=cfg.get("jump_penalty", 0.09),
        )

        for t in range(n_frames):
            idx = track[t]
            if idx >= 0:
                local_floor_db = 20.0 * np.log10(local_rms[t] + 1e-5) - 9.0
                eff_sus = min(sustain_db, max(-38.0, local_floor_db))
                eff_on = eff_sus + (onset_db - sustain_db)
                db_val = mag_db[idx, t]
                if db_val > eff_sus:
                    sustain_active[idx, t] = True
                    if db_val > eff_on or flux_db[idx, t] > 4.0:
                        onset_active[idx, t] = True
                    vel = int(np.clip(45 + (db_val - eff_sus) * (80.0 / max(10.0, abs(eff_sus))), 38, 122))
                    vel_grid[idx, t] = vel

        notes = extract_notes_hysteresis(
            onset_active,
            sustain_active,
            vel_grid,
            flux_db,
            global_flux,
            mag_db,
            min_midi,
            fps,
            min_dur,
            trim_on_chord=False,
        )
        notes = smooth_mono_vibrato(notes)
    else:
        max_poly = cfg.get("max_poly", 6)
        harmonics = [(12, 0.50), (19, 0.32), (24, 0.22), (28, 0.14), (31, 0.10)]

        salience = mag_white_norm.copy()
        for shift, weight in [(12, 0.35), (19, 0.20), (24, 0.12)]:
            if shift < n_notes:
                salience[:-shift, :] += weight * mag_white_norm[shift:, :]

        for t in range(n_frames):
            local_floor_db = 20.0 * np.log10(local_rms[t] + 1e-5) - 7.0
            eff_sus_db = min(sustain_db, max(-36.0, local_floor_db))
            eff_on_db = eff_sus_db + (onset_db - sustain_db)
            eff_sus_lin = 10.0 ** (eff_sus_db / 20.0)

            res_mag = mag_norm[:, t].copy()
            res_sal = salience[:, t].copy()

            for _ in range(max_poly):
                best_idx = int(np.argmax(res_sal))
                best_amp = res_mag[best_idx]
                if best_amp < eff_sus_lin:
                    break

                left = res_mag[best_idx - 1] if best_idx > 0 else 0.0
                right = res_mag[best_idx + 1] if best_idx < n_notes - 1 else 0.0
                if best_amp >= left * 0.96 and best_amp >= right * 0.96:
                    db_val = 20.0 * math.log10(best_amp + 1e-5)
                    sustain_active[best_idx, t] = True
                    if db_val > eff_on_db or flux_db[best_idx, t] > 4.5:
                        onset_active[best_idx, t] = True
                    vel = int(np.clip(40 + (db_val - eff_sus_db) * (82.0 / max(10.0, abs(eff_sus_db))), 35, 122))
                    vel_grid[best_idx, t] = vel

                res_mag[best_idx] = 0.0
                res_sal[best_idx] = 0.0
                if best_idx > 0:
                    res_mag[best_idx - 1] *= 0.22
                    res_sal[best_idx - 1] *= 0.22
                if best_idx < n_notes - 1:
                    res_mag[best_idx + 1] *= 0.22
                    res_sal[best_idx + 1] *= 0.22

                for shift, h_ratio in harmonics:
                    h_idx = best_idx + shift
                    if h_idx < n_notes:
                        sub = best_amp * h_ratio
                        res_mag[h_idx] = max(0.0, res_mag[h_idx] - sub)
                        res_sal[h_idx] = max(0.0, res_sal[h_idx] - sub * 1.1)

        notes = extract_notes_hysteresis(
            onset_active,
            sustain_active,
            vel_grid,
            flux_db,
            global_flux,
            mag_db,
            min_midi,
            fps,
            min_dur,
            trim_on_chord=True,
        )
        notes = prune_ghost_notes(notes)
        notes = estimate_scale_and_prune(notes)

    notes = smart_quantize_notes(notes, bpm, phase_sec, strength=cfg.get("quantize", 0.65))
    notes.sort(key=lambda x: (x[0], x[2]))
    return notes, bpm


def transcribe_drums_stem(
    wav: torch.Tensor, sr: int
) -> Tuple[List[Tuple[float, float, int, int]], float]:
    """Transcribe a drum stem into 6-piece GM drum kit."""
    n_fft = 1024
    hop_length = 256
    fps = sr / hop_length
    window = torch.hann_window(n_fft, device=wav.device)
    with torch.no_grad():
        stft = torch.stft(
            wav.squeeze(0),
            n_fft=n_fft,
            hop_length=hop_length,
            window=window,
            return_complex=True,
        )
        mag = torch.abs(stft).squeeze(0).cpu().numpy()

    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    n_frames = mag.shape[1]
    if n_frames < 4:
        return [], 120.0

    def band_energy(lo: float, hi: float) -> np.ndarray:
        mask = (freqs >= lo) & (freqs <= hi)
        if not np.any(mask):
            return np.zeros(n_frames, dtype=np.float32)
        return np.sqrt(np.mean(mag[mask, :] ** 2, axis=0) + 1e-12)

    kick_env = band_energy(35, 120)
    tom_env = band_energy(120, 210)
    snare_env = 0.55 * band_energy(180, 450) + 0.45 * band_energy(1500, 4000)
    hat_env = band_energy(5800, 10500)
    crash_env = 0.5 * band_energy(3000, 5800) + 0.5 * hat_env

    total_flux = np.maximum(0.0, np.diff(kick_env + snare_env + hat_env, prepend=0.0))
    bpm, phase_sec = estimate_tempo_and_phase(total_flux, fps)

    def detect_hits(env: np.ndarray, min_gap_sec: float, sens: float) -> List[Tuple[int, int]]:
        env_max = float(np.max(env))
        if env_max < 1e-5:
            return []
        norm_env = env / env_max
        flux = np.maximum(0.0, np.diff(norm_env, prepend=norm_env[0]))
        med = float(np.median(flux))
        mad = float(np.median(np.abs(flux - med))) + 1e-5
        thresh = max(0.032, med + sens * 1.4826 * mad)

        min_gap_frames = max(2, int(round(min_gap_sec * fps)))
        last_hit = -min_gap_frames
        hits: List[Tuple[int, int]] = []
        for t in range(1, n_frames - 1):
            if (
                flux[t] > thresh
                and flux[t] >= flux[t - 1]
                and flux[t] >= flux[t + 1]
                and (t - last_hit) >= min_gap_frames
            ):
                last_hit = t
                vel = int(np.clip(52 + norm_env[t] * 70, 42, 125))
                hits.append((t, vel))
        return hits

    kick_hits = detect_hits(kick_env, 0.09, 2.0)
    kick_frames = {t for t, _ in kick_hits}

    snare_hits = detect_hits(snare_env, 0.085, 2.2)
    hat_hits = detect_hits(hat_env, 0.055, 1.85)
    tom_hits = detect_hits(tom_env, 0.11, 2.5)
    crash_hits = detect_hits(crash_env, 0.45, 3.5)

    notes: List[Tuple[float, float, int, int]] = []
    for t, vel in kick_hits:
        s = t / fps
        notes.append((s, s + 0.09, 36, vel))

    for t, vel in snare_hits:
        s = t / fps
        notes.append((s, s + 0.09, 38, vel))

    for t, vel in tom_hits:
        if any(abs(t - kt) <= 2 for kt in kick_frames):
            continue
        s = t / fps
        notes.append((s, s + 0.10, 45, vel))

    hat_norm = hat_env / (float(np.max(hat_env)) + 1e-8)
    sustain_frames = max(4, int(round(0.14 * fps)))
    for t, vel in hat_hits:
        s = t / fps
        end_idx = min(n_frames, t + sustain_frames)
        is_open = end_idx > t + 3 and float(np.mean(hat_norm[t + 2 : end_idx])) > hat_norm[t] * 0.45
        notes.append((s, s + (0.20 if is_open else 0.07), 46 if is_open else 42, vel))

    for t, vel in crash_hits:
        if vel >= 95:
            s = t / fps
            notes.append((s, s + 0.35, 49, vel))

    notes = smart_quantize_notes(notes, bpm, phase_sec, strength=STEM_CONFIG["drums"]["quantize"])
    notes.sort(key=lambda x: (x[0], x[2]))
    return notes, bpm


# ---------------- Pure Python Standard MIDI File (SMF) Writer ---------------- #


def _encode_vlq(value: int) -> bytes:
    value = max(0, int(value))
    out = [value & 0x7F]
    value >>= 7
    while value > 0:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.reverse()
    return bytes(out)


def _make_track_chunk(events: List[Tuple[int, bytes]]) -> bytes:
    """Sort (abs_tick, raw_event_bytes) and serialize as an MTrk chunk."""

    def sort_key(item: Tuple[int, bytes]) -> Tuple[int, int]:
        tick, data = item
        status = data[0] & 0xF0
        order = 0 if status == 0xFF else (1 if status == 0x80 else (2 if status == 0xC0 else 3))
        return (tick, order)

    events_sorted = sorted(events, key=sort_key)
    buf = bytearray()
    prev_tick = 0
    for tick, data in events_sorted:
        delta = max(0, tick - prev_tick)
        prev_tick = tick
        buf.extend(_encode_vlq(delta))
        buf.extend(data)

    buf.extend(_encode_vlq(0))
    buf.extend(b"\xFF\x2F\x00")
    return b"MTrk" + struct.pack(">I", len(buf)) + bytes(buf)


def write_midi_file(
    out_path: str,
    tracks_data: List[dict],
    bpm: float = 120.0,
    tpqn: int = 480,
) -> None:
    """Write a Format 1 Standard MIDI File."""
    tempo_us = int(round(60_000_000 / max(20.0, min(300.0, bpm))))
    ticks_per_sec = tpqn * (bpm / 60.0)

    conductor_events: List[Tuple[int, bytes]] = [
        (0, b"\xFF\x51\x03" + tempo_us.to_bytes(3, "big")),
        (0, b"\xFF\x58\x04\x04\x02\x18\x08"),
    ]
    track_chunks = [_make_track_chunk(conductor_events)]

    for tr in tracks_data:
        ch = tr["channel"] & 0x0F
        prog = tr["program"] & 0x7F
        name_bytes = tr["name"].encode("utf-8", errors="ignore")[:64]

        events: List[Tuple[int, bytes]] = [
            (0, b"\xFF\x03" + _encode_vlq(len(name_bytes)) + name_bytes),
        ]
        if ch != 9:
            events.append((0, bytes([0xC0 | ch, prog])))

        last_off_by_pitch: Dict[int, int] = {}
        for start_s, end_s, pitch, vel in sorted(tr["notes"], key=lambda x: x[0]):
            p = max(0, min(127, int(pitch)))
            v = max(1, min(127, int(vel)))
            on_tick = max(0, int(round(start_s * ticks_per_sec)))
            off_tick = max(on_tick + 1, int(round(end_s * ticks_per_sec)))

            if p in last_off_by_pitch and on_tick < last_off_by_pitch[p]:
                on_tick = last_off_by_pitch[p]
                if off_tick <= on_tick:
                    off_tick = on_tick + 1

            events.append((on_tick, bytes([0x90 | ch, p, v])))
            events.append((off_tick, bytes([0x80 | ch, p, 0])))
            last_off_by_pitch[p] = off_tick

        track_chunks.append(_make_track_chunk(events))

    header = b"MThd" + struct.pack(">IHHH", 6, 1, len(track_chunks), tpqn)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(header)
        for chunk in track_chunks:
            f.write(chunk)


def convert_stem(audio_path: str, stem_id: str, device: str = "auto") -> Tuple[dict, float]:
    cfg = STEM_CONFIG.get(stem_id, STEM_CONFIG["other"])
    wav, sr = load_mono_audio(audio_path, target_sr=22050)
    if device == "auto":
        if torch.cuda.is_available():
            wav = wav.to("cuda")
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            wav = wav.to("mps")

    if cfg["mode"] == "drums":
        notes, bpm = transcribe_drums_stem(wav, sr)
    else:
        notes, bpm = transcribe_pitched_stem(wav, sr, cfg)

    track_dict = {
        "stem_id": stem_id,
        "name": stem_id.capitalize(),
        "channel": cfg["channel"],
        "program": cfg["program"],
        "notes": notes,
    }
    return track_dict, bpm


def main() -> None:
    parser = argparse.ArgumentParser(description="MusicSplitter Audio-to-MIDI Converter")
    parser.add_argument(
        "--stems",
        required=True,
        help="JSON array of {id, path, out_path?} objects",
    )
    parser.add_argument(
        "--mode",
        default="single",
        choices=["single", "individual", "combined"],
        help="Output mode: single file, individual files per stem, or combined multi-track MIDI",
    )
    parser.add_argument("--out", default="", help="Output .mid path for single or combined mode")
    parser.add_argument("--out-dir", default="", help="Output directory for individual mode")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "mps"])
    args = parser.parse_args()

    try:
        stems = json.loads(args.stems)
        if not isinstance(stems, list) or len(stems) == 0:
            raise ValueError("No stems provided for MIDI conversion.")

        total = len(stems)
        converted_tracks = []
        bpms = []
        out_files = []

        for idx, item in enumerate(stems):
            stem_id = str(item["id"]).lower()
            audio_path = str(item["path"])
            emit(
                {
                    "type": "progress",
                    "percent": int((idx / total) * 90),
                    "message": f"{stem_id.capitalize()} 트랙 정밀 MIDI 분석 중...",
                }
            )
            tr, bpm = convert_stem(audio_path, stem_id, device=args.device)
            converted_tracks.append((item, tr, bpm))
            bpms.append(bpm)

        avg_bpm = round(float(np.median(bpms)), 1) if bpms else 120.0

        if args.mode == "single":
            if not args.out:
                raise ValueError("--out is required for single mode")
            _, tr, bpm = converted_tracks[0]
            write_midi_file(args.out, [tr], bpm=bpm)
            out_files.append(args.out)
            note_count = len(tr["notes"])
        elif args.mode == "combined":
            if not args.out:
                raise ValueError("--out is required for combined mode")
            tracks_list = [tr for _, tr, _ in converted_tracks]
            write_midi_file(args.out, tracks_list, bpm=avg_bpm)
            out_files.append(args.out)
            note_count = sum(len(tr["notes"]) for tr in tracks_list)
        else:
            if not args.out_dir:
                raise ValueError("--out-dir is required for individual mode")
            out_dir = Path(args.out_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            note_count = 0
            for item, tr, bpm in converted_tracks:
                target = item.get("out_path") or str(
                    out_dir / f"{Path(item['path']).stem}.mid"
                )
                write_midi_file(target, [tr], bpm=bpm)
                out_files.append(target)
                note_count += len(tr["notes"])

        emit(
            {
                "type": "done",
                "files": out_files,
                "noteCount": note_count,
                "bpm": avg_bpm,
            }
        )
    except Exception as exc:
        emit({"type": "error", "message": str(exc), "traceback": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
