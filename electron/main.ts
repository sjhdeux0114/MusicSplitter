import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const execFileAsync = promisify(execFile);

let mainWindow: BrowserWindow | null = null;
let activeSeparationProc: ChildProcess | null = null;

function resolveBinary(binPath: string | null | undefined, fallback: string): string {
  if (!binPath) return fallback;
  return binPath.replace('app.asar', 'app.asar.unpacked');
}

const FFMPEG_BIN = resolveBinary(ffmpegStatic, 'ffmpeg');
const FFPROBE_BIN = resolveBinary(ffprobeStatic?.path, 'ffprobe');

function getEngineDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'engine');
  }
  return path.join(__dirname, '..', 'engine');
}

function getExeDir(): string {
  if (!app.isPackaged) {
    return process.cwd();
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  if (process.platform === 'darwin') {
    // MusicSplitter.app/Contents/MacOS/MusicSplitter -> folder containing .app
    return path.resolve(path.dirname(process.execPath), '../../..');
  }
  return path.dirname(process.execPath);
}

function getManagedVenvDir(): string {
  const exeDir = getExeDir();
  try {
    fs.accessSync(exeDir, fs.constants.W_OK);
    return path.join(exeDir, 'py-env');
  } catch {
    return path.join(app.getPath('userData'), 'py-env');
  }
}

function getVenvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

async function testPythonHasDemucs(pythonBin: string): Promise<{ ok: boolean; hasGpu: boolean; gpuName?: string }> {
  try {
    const code =
      "import json, torch, demucs, soundfile; " +
      "cuda = torch.cuda.is_available(); " +
      "mps = hasattr(torch.backends, 'mps') and torch.backends.mps.is_available(); " +
      "name = torch.cuda.get_device_name(0) if cuda else ('Apple Silicon MPS' if mps else 'CPU'); " +
      "print(json.dumps({'gpu': bool(cuda or mps), 'name': name}))";
    const { stdout } = await execFileAsync(pythonBin, ['-c', code], { timeout: 20000 });
    const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    return { ok: true, hasGpu: Boolean(parsed.gpu), gpuName: parsed.name };
  } catch {
    return { ok: false, hasGpu: false };
  }
}

async function findSystemPython(): Promise<string | null> {
  const candidates =
    process.platform === 'win32'
      ? ['python', 'py -3', 'python3']
      : ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python'];

  for (const cmd of candidates) {
    try {
      const parts = cmd.split(' ');
      const bin = parts[0];
      const args = [...parts.slice(1), '--version'];
      const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 5000 });
      const out = (stdout + stderr).trim();
      if (out.startsWith('Python 3.')) {
        // Resolve exact executable path
        const { stdout: exeOut } = await execFileAsync(
          bin,
          [...parts.slice(1), '-c', 'import sys; print(sys.executable)'],
          { timeout: 5000 }
        );
        return exeOut.trim();
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function resolveReadyPython(): Promise<{
  pythonPath: string | null;
  systemPython: string | null;
  hasGpu: boolean;
  gpuName?: string;
}> {
  const candidates: string[] = [];

  const managedPy = getVenvPython(getManagedVenvDir());
  if (fs.existsSync(managedPy)) candidates.push(managedPy);

  const localVenvPy = getVenvPython(path.join(process.cwd(), '.venv'));
  if (fs.existsSync(localVenvPy)) candidates.push(localVenvPy);

  const sysPy = await findSystemPython();
  if (sysPy) candidates.push(sysPy);

  for (const py of candidates) {
    const res = await testPythonHasDemucs(py);
    if (res.ok) {
      return { pythonPath: py, systemPython: sysPy, hasGpu: res.hasGpu, gpuName: res.gpuName };
    }
  }

  return { pythonPath: null, systemPython: sysPy, hasGpu: false };
}

function getIconPath(): string {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  if (app.isPackaged) {
    return path.join(__dirname, '..', 'build', iconName);
  }
  return path.join(__dirname, '..', 'build', iconName);
}

async function detectNvidiaGpu(): Promise<string | null> {
  if (process.platform === 'darwin') return null;
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name', '--format=csv,noheader'],
      { timeout: 5000 }
    );
    const name = stdout.trim().split('\n')[0]?.trim();
    return name || null;
  } catch {
    return null;
  }
}

function createWindow(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#111216',
    icon: getIconPath(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (!app.isPackaged && process.env.NODE_ENV !== 'production') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

function cleanupTempFiles(): void {
  const sessionsDir = path.join(app.getPath('userData'), 'sessions');
  try {
    if (fs.existsSync(sessionsDir)) {
      for (const entry of fs.readdirSync(sessionsDir)) {
        try {
          fs.rmSync(path.join(sessionsDir, entry), {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100
          });
        } catch {
          // ignore locked entry so other old sessions still get deleted
        }
      }
      try {
        if (fs.readdirSync(sessionsDir).length === 0) {
          fs.rmdirSync(sessionsDir);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore cleanup errors
  }

  try {
    const tmpDir = os.tmpdir();
    for (const entry of fs.readdirSync(tmpDir)) {
      if (entry.startsWith('musicsplitter_')) {
        try {
          fs.rmSync(path.join(tmpDir, entry), {
            recursive: true,
            force: true,
            maxRetries: 2,
            retryDelay: 50
          });
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore tmpdir scan errors
  }
}

app.on('window-all-closed', () => {
  if (activeSeparationProc) {
    activeSeparationProc.kill();
    activeSeparationProc = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (activeSeparationProc) {
    activeSeparationProc.kill();
    activeSeparationProc = null;
  }
  cleanupTempFiles();
});

// IPC Handlers

ipcMain.handle('check-environment', async () => {
  const res = await resolveReadyPython();
  return {
    ready: Boolean(res.pythonPath),
    pythonPath: res.pythonPath,
    systemPython: res.systemPython,
    venvDir: getManagedVenvDir(),
    ffmpegPath: FFMPEG_BIN,
    hasGpu: res.hasGpu,
    gpuName: res.gpuName
  };
});

ipcMain.handle('setup-environment', async () => {
  const sendLog = (msg: string) => {
    mainWindow?.webContents.send('setup-log', msg);
  };

  try {
    const sysPy = await findSystemPython();
    if (!sysPy) {
      return {
        ok: false,
        error: 'Python 3.10+가 시스템에 설치되어 있지 않습니다. python.org에서 Python을 먼저 설치해 주세요.'
      };
    }

    const venvDir = getManagedVenvDir();
    const venvPy = getVenvPython(venvDir);
    if (!fs.existsSync(venvPy)) {
      sendLog(`가상환경 생성 중: ${venvDir}`);
      await execFileAsync(sysPy, ['-m', 'venv', venvDir], { timeout: 60000 });
    }

    const runPip = (pipArgs: string[]) =>
      new Promise<void>((resolve, reject) => {
        const proc = spawn(venvPy, ['-m', 'pip', ...pipArgs], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        proc.stdout.on('data', (d) => sendLog(d.toString()));
        proc.stderr.on('data', (d) => sendLog(d.toString()));
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`pip ${pipArgs[0]} failed with code ${code}`));
        });
      });

    await runPip(['install', '--upgrade', 'pip']);

    const nvidiaGpu = await detectNvidiaGpu();
    if (nvidiaGpu) {
      sendLog(`NVIDIA GPU 감지됨 (${nvidiaGpu}) → CUDA 12.4 GPU 가속 PyTorch를 설치합니다...`);
      await runPip([
        'install',
        'torch',
        'torchaudio',
        '--index-url',
        'https://download.pytorch.org/whl/cu124'
      ]);
      sendLog('Demucs 및 오디오 라이브러리 설치 중...');
      await runPip(['install', 'demucs>=4.0.1', 'soundfile>=0.12.1', 'numpy>=1.24.0']);
    } else {
      const reqPath = path.join(getEngineDir(), 'requirements.txt');
      sendLog('AI 음원 분리 엔진(Demucs, PyTorch) 설치 중... (최초 1회, 수 분 소요될 수 있습니다)');
      await runPip(['install', '-r', reqPath]);
    }

    sendLog('설치 완료!');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendLog(`오류: ${msg}`);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('reset-environment', async () => {
  const targets = [getManagedVenvDir(), path.join(app.getPath('userData'), 'py-env')];
  const uniqueTargets = Array.from(new Set(targets));
  const removed: string[] = [];
  for (const dir of uniqueTargets) {
    if (fs.existsSync(dir)) {
      await fs.promises.rm(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  return { ok: true, removed };
});

ipcMain.handle('select-audio-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '분리할 오디오 파일 선택',
    properties: ['openFile'],
    filters: [
      {
        name: 'Audio Files',
        extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus']
      },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-audio-info', async (_ev, filePath: string) => {
  const stats = fs.statSync(filePath);
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-select_streams',
        'a:0',
        filePath
      ],
      { timeout: 10000 }
    );
    const data = JSON.parse(stdout);
    const stream = data.streams?.[0] || {};
    const fmt = data.format || {};
    return {
      duration: Number(fmt.duration || stream.duration || 0),
      formatName: String(fmt.format_name || path.extname(filePath).slice(1)).toUpperCase(),
      sampleRate: Number(stream.sample_rate || 44100),
      channels: Number(stream.channels || 2),
      bitRate: Number(fmt.bit_rate || stream.bit_rate || 0),
      sizeBytes: stats.size
    };
  } catch {
    return {
      duration: 0,
      formatName: path.extname(filePath).slice(1).toUpperCase(),
      sampleRate: 44100,
      channels: 2,
      bitRate: 0,
      sizeBytes: stats.size
    };
  }
});

ipcMain.handle('read-audio-buffer', async (_ev, filePath: string) => {
  const buf = await fs.promises.readFile(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle(
  'start-separation',
  async (
    _ev,
    params: {
      inputPath: string;
      mode: '2stems' | '4stems' | '4stems_hq' | '6stems';
      format: 'wav' | 'mp3' | 'flac' | 'ogg';
      device?: 'auto' | 'cpu' | 'cuda' | 'mps';
    }
  ) => {
    const env = await resolveReadyPython();
    if (!env.pythonPath) {
      return { ok: false, error: 'Python AI 엔진(Demucs)이 준비되지 않았습니다. 먼저 환경을 설정해 주세요.' };
    }

    const baseName = path.basename(params.inputPath, path.extname(params.inputPath));
    const safeName = baseName.replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
    const outputDir = path.join(app.getPath('userData'), 'sessions', `${Date.now()}_${safeName}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const scriptPath = path.join(getEngineDir(), 'separate.py');
    const args = [
      scriptPath,
      '--input',
      params.inputPath,
      '--output-dir',
      outputDir,
      '--mode',
      params.mode,
      '--format',
      params.format,
      '--ffmpeg',
      FFMPEG_BIN,
      '--device',
      params.device || 'auto'
    ];

    return new Promise((resolve) => {
      const proc = spawn(env.pythonPath!, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      activeSeparationProc = proc;

      let lineBuf = '';
      let errBuf = '';
      let resolved = false;

      proc.stdout.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString('utf8');
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            mainWindow?.webContents.send('separation-progress', parsed);
            if (parsed.type === 'done' && !resolved) {
              resolved = true;
              resolve({ ok: true, stems: parsed.stems, outputDir });
            } else if (parsed.type === 'error' && !resolved) {
              resolved = true;
              resolve({ ok: false, error: parsed.message || '분리 중 오류가 발생했습니다.' });
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        errBuf += chunk.toString('utf8');
        if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
      });

      proc.on('close', (code) => {
        if (activeSeparationProc === proc) {
          activeSeparationProc = null;
        }
        if (!resolved) {
          resolved = true;
          if (code === 0) {
            resolve({ ok: false, error: '분리 결과를 받지 못했습니다.' });
          } else {
            resolve({ ok: false, error: `분리 프로세스가 종료되었습니다 (code ${code}). ${errBuf.slice(-300)}` });
          }
        }
      });
    });
  }
);

ipcMain.handle('cancel-separation', async () => {
  if (activeSeparationProc) {
    activeSeparationProc.kill();
    activeSeparationProc = null;
  }
});

const pitchJobs = new Map<string, Promise<string>>();
let rubberbandSupported: boolean | null = null;

async function isRubberbandSupported(): Promise<boolean> {
  if (rubberbandSupported !== null) return rubberbandSupported;
  try {
    const { stdout } = await execFileAsync(FFMPEG_BIN, ['-filters'], { timeout: 5000 });
    rubberbandSupported = /\brubberband\b/.test(stdout);
  } catch {
    rubberbandSupported = false;
  }
  return rubberbandSupported;
}

function buildPitchFilter(semitones: number, stemId: string, useRubberband: boolean): string {
  const ratio = Math.pow(2, semitones / 12);
  if (useRubberband) {
    const formant = stemId === 'vocals' ? ':formant=preserved' : '';
    return `rubberband=pitch=${ratio.toFixed(8)}:channels=together${formant}`;
  }
  // Fallback for ffmpeg builds without librubberband (ratio is in [0.5, 2.0] for -12..+12 semitones)
  const invRatio = 1 / ratio;
  return `aresample=44100,asetrate=${(44100 * ratio).toFixed(4)},aresample=44100,atempo=${invRatio.toFixed(8)}`;
}

async function getOrCreatePitchedStemFile(
  sourcePath: string,
  stemId: string,
  semitones: number,
  sessionDir?: string
): Promise<string> {
  if (!semitones || semitones === 0 || stemId === 'drums') {
    return sourcePath;
  }

  const baseRoot = sessionDir || path.dirname(sourcePath);
  const cacheDir = path.join(baseRoot, '.pitch_cache', `st_${semitones}`);
  await fs.promises.mkdir(cacheDir, { recursive: true });

  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const cachedPath = path.join(cacheDir, `${baseName}.wav`);

  if (fs.existsSync(cachedPath)) {
    const stat = await fs.promises.stat(cachedPath);
    if (stat.size > 0) return cachedPath;
  }

  const jobKey = `${sourcePath}::${stemId}::${semitones}`;
  const existingJob = pitchJobs.get(jobKey);
  if (existingJob) return existingJob;

  const job = (async () => {
    const tmpPath = path.join(cacheDir, `${baseName}.${Date.now()}.tmp.wav`);
    const useRubberband = await isRubberbandSupported();
    const filter = buildPitchFilter(semitones, stemId, useRubberband);
    try {
      await execFileAsync(
        FFMPEG_BIN,
        ['-y', '-i', sourcePath, '-af', filter, '-c:a', 'pcm_s24le', tmpPath],
        { timeout: 180000 }
      );
      await fs.promises.rename(tmpPath, cachedPath);
      return cachedPath;
    } catch (err) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    } finally {
      pitchJobs.delete(jobKey);
    }
  })();

  pitchJobs.set(jobKey, job);
  return job;
}

ipcMain.handle(
  'pitch-shift-stems',
  async (
    _ev,
    params: {
      stems: Array<{ id: string; path: string }>;
      semitones: number;
      sessionDir?: string;
    }
  ) => {
    try {
      const results = await Promise.all(
        params.stems.map(async (stem) => {
          const resolvedPath = await getOrCreatePitchedStemFile(
            stem.path,
            stem.id,
            params.semitones,
            params.sessionDir
          );
          return { id: stem.id, path: resolvedPath };
        })
      );
      return { ok: true, results };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }
);

async function encodeFileWithFfmpeg(sourcePath: string, targetPath: string, format: string): Promise<void> {
  const ext = path.extname(sourcePath).slice(1).toLowerCase();
  if (ext === format.toLowerCase()) {
    await fs.promises.copyFile(sourcePath, targetPath);
    return;
  }

  let args: string[] = [];
  if (format === 'wav') {
    args = ['-y', '-i', sourcePath, '-c:a', 'pcm_s24le', targetPath];
  } else if (format === 'mp3') {
    args = ['-y', '-i', sourcePath, '-c:a', 'libmp3lame', '-b:a', '320k', targetPath];
  } else if (format === 'flac') {
    args = ['-y', '-i', sourcePath, '-c:a', 'flac', '-compression_level', '5', targetPath];
  } else if (format === 'ogg') {
    args = ['-y', '-i', sourcePath, '-c:a', 'libvorbis', '-q:a', '8', targetPath];
  } else {
    throw new Error(`Unsupported format: ${format}`);
  }
  await execFileAsync(FFMPEG_BIN, args, { timeout: 120000 });
}

ipcMain.handle(
  'export-single-stem',
  async (
    _ev,
    params: {
      sourcePath: string;
      defaultName: string;
      format: string;
      stemId?: string;
      pitchSemitones?: number;
      sessionDir?: string;
    }
  ) => {
    if (!mainWindow) return { ok: false, canceled: true };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '트랙 내보내기',
      defaultPath: `${params.defaultName}.${params.format}`,
      filters: [{ name: `${params.format.toUpperCase()} Audio`, extensions: [params.format] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const effectiveSource = await getOrCreatePitchedStemFile(
      params.sourcePath,
      params.stemId || '',
      params.pitchSemitones || 0,
      params.sessionDir
    );
    await encodeFileWithFfmpeg(effectiveSource, filePath, params.format);
    return { ok: true, savedPath: filePath };
  }
);

ipcMain.handle(
  'export-all-stems',
  async (
    _ev,
    params: {
      stems: Array<{ id: string; name: string; path: string }>;
      format: string;
      pitchSemitones?: number;
      sessionDir?: string;
    }
  ) => {
    if (!mainWindow) return { ok: false, canceled: true };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '모든 스템을 저장할 폴더 선택',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    const targetDir = filePaths[0];
    const semitones = params.pitchSemitones || 0;
    for (const stem of params.stems) {
      const base = path.basename(stem.path, path.extname(stem.path));
      const keySuffix =
        semitones !== 0 && stem.id !== 'drums'
          ? `_${semitones > 0 ? `+${semitones}` : semitones}key`
          : '';
      const outPath = path.join(targetDir, `${base}${keySuffix}.${params.format}`);
      const effectiveSource = await getOrCreatePitchedStemFile(
        stem.path,
        stem.id,
        semitones,
        params.sessionDir
      );
      await encodeFileWithFfmpeg(effectiveSource, outPath, params.format);
    }
    return { ok: true, targetDir };
  }
);

ipcMain.handle(
  'export-custom-mix',
  async (
    _ev,
    params: {
      stems: Array<{ id?: string; path: string; volume: number }>;
      format: string;
      defaultName: string;
      pitchSemitones?: number;
      sessionDir?: string;
    }
  ) => {
    if (!mainWindow) return { ok: false, canceled: true };
    if (params.stems.length === 0) {
      return { ok: false, error: '내보낼 활성 트랙이 없습니다.' };
    }
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '커스텀 믹스 내보내기',
      defaultPath: `${params.defaultName}_custom_mix.${params.format}`,
      filters: [{ name: `${params.format.toUpperCase()} Audio`, extensions: [params.format] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    const semitones = params.pitchSemitones || 0;
    const resolvedStems = await Promise.all(
      params.stems.map(async (s) => ({
        ...s,
        effectivePath: await getOrCreatePitchedStemFile(
          s.path,
          s.id || '',
          semitones,
          params.sessionDir
        )
      }))
    );

    const args: string[] = ['-y'];
    for (const s of resolvedStems) {
      args.push('-i', s.effectivePath);
    }

    const filterParts: string[] = [];
    const mixInputs: string[] = [];
    resolvedStems.forEach((s, idx) => {
      const label = `a${idx}`;
      filterParts.push(`[${idx}:a]volume=${s.volume.toFixed(3)}[${label}]`);
      mixInputs.push(`[${label}]`);
    });

    if (resolvedStems.length === 1) {
      args.push('-filter_complex', `${filterParts[0]}`, '-map', '[a0]');
    } else {
      filterParts.push(`${mixInputs.join('')}amix=inputs=${resolvedStems.length}:duration=longest:normalize=0[out]`);
      args.push('-filter_complex', filterParts.join(';'), '-map', '[out]');
    }

    if (params.format === 'wav') {
      args.push('-c:a', 'pcm_s24le');
    } else if (params.format === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', '320k');
    } else if (params.format === 'flac') {
      args.push('-c:a', 'flac', '-compression_level', '5');
    } else if (params.format === 'ogg') {
      args.push('-c:a', 'libvorbis', '-q:a', '8');
    }
    args.push(filePath);

    await execFileAsync(FFMPEG_BIN, args, { timeout: 180000 });
    return { ok: true, savedPath: filePath };
  }
);

async function runMidiConverter(args: string[]): Promise<{
  ok: boolean;
  files?: string[];
  noteCount?: number;
  bpm?: number;
  error?: string;
}> {
  const env = await resolveReadyPython();
  if (!env.pythonPath) {
    return {
      ok: false,
      error: 'Python AI 엔진이 준비되지 않았습니다. 먼저 환경을 설정해 주세요.'
    };
  }

  const scriptPath = path.join(getEngineDir(), 'midi_convert.py');
  return new Promise((resolve) => {
    const proc = spawn(env.pythonPath!, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let lineBuf = '';
    let errBuf = '';
    let resolved = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8');
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'progress') {
            mainWindow?.webContents.send('midi-progress', parsed);
          } else if (parsed.type === 'done' && !resolved) {
            resolved = true;
            resolve({
              ok: true,
              files: parsed.files,
              noteCount: parsed.noteCount,
              bpm: parsed.bpm
            });
          } else if (parsed.type === 'error' && !resolved) {
            resolved = true;
            resolve({ ok: false, error: parsed.message || 'MIDI 변환 중 오류가 발생했습니다.' });
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      errBuf += chunk.toString('utf8');
      if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        resolve({
          ok: false,
          error:
            code === 0
              ? 'MIDI 변환 결과를 받지 못했습니다.'
              : `MIDI 변환 프로세스가 종료되었습니다 (code ${code}). ${errBuf.slice(-300)}`
        });
      }
    });
  });
}

ipcMain.handle(
  'convert-stem-to-midi',
  async (
    _ev,
    params: {
      sourcePath: string;
      stemId: string;
      defaultName: string;
      pitchSemitones?: number;
      sessionDir?: string;
    }
  ) => {
    if (!mainWindow) return { ok: false, canceled: true };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'MIDI 파일로 변환 저장',
      defaultPath: `${params.defaultName}.mid`,
      filters: [{ name: 'MIDI File', extensions: ['mid', 'midi'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    const effectiveSource = await getOrCreatePitchedStemFile(
      params.sourcePath,
      params.stemId,
      params.pitchSemitones || 0,
      params.sessionDir
    );

    const stemsPayload = JSON.stringify([{ id: params.stemId, path: effectiveSource }]);
    const res = await runMidiConverter([
      '--mode',
      'single',
      '--out',
      filePath,
      '--stems',
      stemsPayload
    ]);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, savedPath: filePath, noteCount: res.noteCount, bpm: res.bpm };
  }
);

ipcMain.handle(
  'convert-stems-to-midi',
  async (
    _ev,
    params: {
      stems: Array<{ id: string; name: string; path: string }>;
      mode: 'individual' | 'combined';
      defaultName: string;
      pitchSemitones?: number;
      sessionDir?: string;
    }
  ) => {
    if (!mainWindow) return { ok: false, canceled: true };
    if (params.stems.length === 0) {
      return { ok: false, error: '변환할 스템이 없습니다.' };
    }

    const semitones = params.pitchSemitones || 0;

    if (params.mode === 'combined') {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: '통합 멀티트랙 MIDI 저장',
        defaultPath: `${params.defaultName}_all_stems.mid`,
        filters: [{ name: 'MIDI File', extensions: ['mid', 'midi'] }]
      });
      if (canceled || !filePath) return { ok: false, canceled: true };

      const resolved = await Promise.all(
        params.stems.map(async (s) => ({
          id: s.id,
          path: await getOrCreatePitchedStemFile(s.path, s.id, semitones, params.sessionDir)
        }))
      );
      const res = await runMidiConverter([
        '--mode',
        'combined',
        '--out',
        filePath,
        '--stems',
        JSON.stringify(resolved)
      ]);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, savedPath: filePath, noteCount: res.noteCount, bpm: res.bpm };
    }

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '개별 MIDI 파일들을 저장할 폴더 선택',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };

    const targetDir = filePaths[0];
    const resolved = await Promise.all(
      params.stems.map(async (s) => {
        const effectivePath = await getOrCreatePitchedStemFile(
          s.path,
          s.id,
          semitones,
          params.sessionDir
        );
        const base = path.basename(s.path, path.extname(s.path));
        const keySuffix =
          semitones !== 0 && s.id !== 'drums'
            ? `_${semitones > 0 ? `+${semitones}` : semitones}key`
            : '';
        return {
          id: s.id,
          path: effectivePath,
          out_path: path.join(targetDir, `${base}${keySuffix}.mid`)
        };
      })
    );

    const res = await runMidiConverter([
      '--mode',
      'individual',
      '--out-dir',
      targetDir,
      '--stems',
      JSON.stringify(resolved)
    ]);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      targetDir,
      files: res.files,
      noteCount: res.noteCount,
      bpm: res.bpm
    };
  }
);

ipcMain.handle('open-folder', async (_ev, targetPath: string) => {
  if (fs.existsSync(targetPath)) {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      await shell.openPath(targetPath);
    } else {
      shell.showItemInFolder(targetPath);
    }
  }
});
