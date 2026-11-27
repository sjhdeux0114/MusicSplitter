# MusicSplitter

Apple **Logic Pro Stem Splitter** 스타일의 오프라인 AI 음원 분리 데스크톱 애플리케이션입니다.  
Meta **Demucs** (`htdemucs`, `htdemucs_ft`, `htdemucs_6s`) 및 **FFmpeg**를 기반으로 보컬과 악기별 트랙을 고품질로 분리하고, 멀티트랙 DAW 믹서에서 바로 들어보며 내보낼 수 있습니다.

## 주요 기능

- **Logic Pro 스타일 스템 분리 모드**
  - **2 Stems**: 보컬 (Vocals) / 반주 (Instrumental)
  - **4 Stems**: 보컬 · 드럼 · 베이스 · 기타 악기
  - **6 Stems (Logic Pro 풀 스템)**: 보컬 · 드럼 · 베이스 · 기타 · 피아노 · 기타 악기
  - **4 Stems HQ**: Fine-tuned 고품질 마스터 분리
- **다양한 오디오 포맷 입출력 지원**
  - **MP3, WAV, FLAC, OGG** (및 M4A, AAC 입력) 완벽 호환
- **멀티트랙 DAW 믹서 & 파형 뷰어**
  - 트랙별 **Mute (M)** / **Solo (S)** / **볼륨 페이더**
  - 실시간 동기화 재생 및 클릭 가능한 파형 타임라인
  - 빠른 프리셋 (전체 트랙 / 보컬만 듣기 / MR만 듣기)
  - 개별 트랙 저장, 모든 스템 일괄 내보내기, 현재 믹스(M/S/볼륨 반영) 내보내기
- **크로스 플랫폼 (Windows & macOS)**
  - Windows (`.exe` 설치/포터블) 및 macOS (`.dmg` / `.zip` Apple Silicon & Intel) 빌드 지원
  - NVIDIA CUDA / Apple Silicon MPS GPU 가속 자동 감지

## 개발 및 빌드

```bash
npm install
npm run dev        # 개발 모드 실행
npm run typecheck  # TypeScript 타입 체크
npm run build      # 프로덕션 번들 빌드
npm run dist:win   # Windows 인스톨러 & 포터블 빌드
npm run dist:mac   # macOS DMG & ZIP 빌드 (macOS 환경)
```

## 요구 사항

- Node.js 20+
- Python 3.10+ (최초 실행 시 앱 내 **원클릭 자동 설치**를 통해 `demucs`, `torch`, `soundfile`을 자동 구성합니다)
