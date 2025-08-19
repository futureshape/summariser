Live audio (or simulated) → transcription → incremental “live‑blog” summarisation.

This project acts as a minimal, hackable reference for turning a continuously arriving audio stream into structured summary cards with OpenAI models.

## Current core behaviour

Two modes:
1. Simulated playback (CLI `--file`): Segments a static audio file and pretends it is arriving live. Every processed segment window is summarised (legacy style) with `summariseWindow`.
2. Browser live stream (default UI): The browser decodes the chosen audio file, sends raw PCM over WebSocket in tiny chunks. The server batches & transcribes, keeps a growing transcript string, and every N seconds (default 10s) runs a timer‑based **diff summariser** (`timerBasedSummarise`) using:
	 - `lastWords`: the last X words (default 40) of the full transcript
	 - `previousSummary`: the headline + bullets produced previously
	 The model is instructed to emit only NEW information. If nothing new = an empty/no‑op summary.

## Key design points

* Single accumulating transcript (`completeTranscript`). No sentence boundary heuristics, no rolling buffer complexity.
* Timer‑based summariser = resistant to repetition: previous summary context passed each time.
* Structured JSON output: `{ headline, bullets[], quotes[], entities[] }` for both summariser variants.
* Transport:
	* WebSocket `/audio-stream` for PCM ingest (browser → server).
	* Server‑Sent Events `/stream` for UI updates (`chunk`, `transcript_piece`, `eof`).
* Clear debug tags in server logs:
	* `[WS]` WebSocket level events / connection / file IO
	* `[TRANSCRIPT]` Transcription pipeline (segmenting, chunk transcription, appending)
	* `[SUMMARISER]` Summariser inputs, outputs, and errors

## What was removed (legacy / NOT present now)

* Sentence splitting & sentence‑based incremental summarisation
* Rolling buffer multi‑strategy UI controls
* “Summary max sentences” configuration
* Extra time metadata on summary objects

All summarisation is either (a) window summarisation in simulation mode or (b) timer diff summarisation in live mode.

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

# (Alternative) Run server only (no preloaded file – pick one in the browser UI)
npm run dev

# 5) Open the UI
open http://localhost:5173
```

## CLI flags (simulation mode)

| Flag | Default | Purpose |
|------|---------|---------|
| `--file` | (none) | Path to audio file. If omitted, only the UI server starts for live streaming via browser. |
| `--chunk` | 15 | Segment length (seconds) for simulated mode. |
| `--hold` | 1 | Extra seconds to wait after each segment before summarising (lets “late” transcript settle). |
| `--speed` | 1.0 | Playback speed multiplier for simulation pacing. |
| `--serve` | true | Whether to start the UI HTTP server. |

## Browser → server handshake parameters

Sent once over WebSocket when the client starts streaming:

| Field | Source (UI input) | Default | Meaning |
|-------|-------------------|---------|---------|
| `format` | fixed | `s16le` | Raw PCM encoding sent by browser. |
| `sampleRate` | decoded file | (file SR) | Audio sample rate. |
| `channels` | decoded file | (file channels) | Channel count. (Currently mixed / interleaved as provided) |
| `name` | file | (filename) | Original file name (debug only). |
| `clientChunkMs` | Chunk (ms) | 250 | Size of client send slices. Smaller = lower latency, more overhead. |
| `summaryWords` | Summary max words | 40 | Number of trailing transcript words fed into timer summariser each cycle. |
| `segmentSeconds` | Segment window (s) | 15 | How server slices buffered audio for transcription batches. |
| `processIntervalMs` | Process interval (ms) | 10000 | How often server flushes buffered PCM to disk + transcribes. |
| `summaryIntervalMs` | (not exposed in UI) | 10000 | Interval between timer‑based summary calls (can be added to UI later). |

## Environment variables

Create `.env` (see `.env.example` if present):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (none) | Required OpenAI key. |
| `TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | Transcription model (fallback: `whisper-1`). |
| `SUMMARISE_MODEL` | `gpt-4o-mini` | Summarisation model for both strategies. |
| `CONTEXT_TITLE` | (empty) | Optional added context in prompts. |
| `CONTEXT_SPEAKER` | (empty) | Optional speaker name. |
| `CONTEXT_ABSTRACT` | (empty) | Optional abstract for background (ignored by timer diff if not helpful). |

## Runtime flow (live / browser mode)

1. Browser decodes audio file to PCM and sends small slices (`clientChunkMs`).
2. Server accumulates PCM until `processIntervalMs` elapses, writes WAV, then segments into `segmentSeconds` pieces for transcription (ffmpeg).
3. Each segment is transcribed → `transcript_piece` SSE events sent to UI.
4. Full text appended to `completeTranscript`.
5. Every `summaryIntervalMs`, server extracts last `summaryWords` words + previous summary → `[SUMMARISER] INPUT` log.
6. `timerBasedSummarise` returns JSON. If headline non‑empty, broadcast as `chunk` SSE.
7. UI prepends card to list.

## Runtime flow (simulation CLI mode)

1. CLI segments file immediately into `--chunk` size slices.
2. For each slice (simulated time advanced using `--speed`), transcribe and accumulate in a rolling window (~max of 2 * `--chunk` or 30s minimum).
3. Call `summariseWindow` for that window → broadcast `chunk` SSE.

## Data contracts

SSE events:

| Event | Payload |
|-------|---------|
| `transcript_piece` | `{ index, path, text }` per segment transcription. |
| `chunk` | LiveBlog summary `{ id, headline, bullets[], quotes[], entities[], revision_of:null }`. |
| `eof` | `{ done: true }` when simulation completes. |

WebSocket path `/audio-stream`: binary audio messages after one JSON handshake.

## Debugging

Watch the server logs for:
* `[TRANSCRIPT]` – segmentation, per‑chunk transcription, transcript growth.
* `[SUMMARISER]` – inputs (lastWords/previousSummary) and generated summary headlines (or “No new content”).
* `[WS]` – connection lifecycle, buffering, temp file writes.

If you need deeper LLM payload inspection you can briefly re‑introduce more verbose logging around `timerBasedSummarise` (search for `[SUMMARISER] INPUT`).

## Extending

Potential low‑risk additions:
* Expose `summaryIntervalMs` in the UI.
* Add entity enrichment post‑processing.
* Add persistence (write emitted cards to disk or database).
* Simple rate limiting or backpressure if multiple clients stream simultaneously.

## Limitations / notes

* No speaker diarisation – all text assumed single speaker.
* Summaries rely on model correctness for “ONLY NEW” constraint — may occasionally repeat.
* Timer summariser currently uses a flat string diff context (previous summary string). A structured diff could further reduce repeats.
* No retry/backoff for OpenAI errors (minimal demo). Add wrapper if running long sessions.

## Model choices

Transcription and summarisation models are configurable with environment variables; defaults emphasise speed and cost over maximal accuracy.

| Purpose | Default | Alternatives |
|---------|---------|-------------|
| Transcription | `gpt-4o-transcribe` | `whisper-1` |
| Summarisation | `gpt-4o-mini` | Any Responses‑capable GPT‑4o family model |

Switch via env vars in `.env`.