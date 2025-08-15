A minimal end‑to‑end blueprint that **simulates a live conference** using **local audio files**. It transcribes short chunks, turns them into **live‑blog cards**, and streams them to a tiny web UI.

- **No live ingest required** – point it at an MP3/WAV and it plays the file back “as if live”.
- Uses **OpenAI** for transcription and summarisation.
- Latency knobs so you can make it feel real‑time.

## Features

- Chunked transcription (default 15 s windows with a 1 s hold‑back)
- JSON **Structured Output** from the summariser for predictable UI
- SSE stream to the front‑end (no framework required)
- Minimal, hackable TypeScript code

## Quick start

```bash
# 1) Prereqs
# - Node 20+
# - ffmpeg in your PATH

# 2) Install
npm i

# 3) Configure
cp .env.example .env
# edit .env and add your OPENAI_API_KEY

# 4) Run server (simulates live from your audio file)
# Replace path with your file (wav/mp3/m4a/ogg)
npm run dev -- --file ./samples/talk.mp3 --chunk 15 --hold 1 --speed 1.0

# 5) Open the UI
open http://localhost:5173
```

**Flags**
- `--file` path to audio file (required)
- `--chunk` seconds per chunk (default 15)
- `--hold` seconds to hold after each chunk before summarising (default 1)
- `--speed` playback speed multiplier (e.g. 1.5 for faster simulation)

## How it works

1) `ffmpeg` segments your file into N-second chunks (Opus @ 16 kHz).
2) Each chunk is sent to **OpenAI Transcription** (`gpt-4o-transcribe` or `whisper-1`).
3) The running transcript buffer for the last ~30–60 s is passed to the **Summariser** (`gpt-4o-mini`) with a JSON schema to produce a live‑blog card.
4) Cards are broadcast over **SSE** on `/stream` and rendered by the tiny web UI.

## Model choices

- Transcription: `gpt-4o-transcribe` (preferred) or `whisper-1` (fallback)
- Summariser: `gpt-4o-mini`

Switch via env vars in `.env`.
