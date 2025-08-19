import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { segmentFile, cleanup } from "./segmenter.js";
import { transcribeChunk, summariseWindow, timerBasedSummarise } from "./openai.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveBlogChunk } from "./schema.js";

const argv = await yargs(hideBin(process.argv))
  .option("file", { type: "string", demandOption: false, describe: "Path to audio file (optional for live)" })
  .option("chunk", { type: "number", default: 15, describe: "Seconds per chunk" })
  .option("hold", { type: "number", default: 1, describe: "Hold-back seconds before summarising" })
  .option("speed", { type: "number", default: 1.0, describe: "Playback speed multiplier" })
  .option("serve", { type: "boolean", default: true, describe: "Start web UI server" })
  .parse();

const app = express();
const http = createServer(app);

// Static UI
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(readFileSync(join(process.cwd(), "src", "ui.html"), "utf8"));
});

// SSE stream of live-blog chunks
const clients = new Set<{ id: string; res: express.Response }>();
app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });
  const id = randomUUID();
  clients.add({ id, res });
  req.on("close", () => { clients.forEach(c => c.id === id && clients.delete(c)); });
});

function broadcast(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.res.write(payload);
}

http.listen(5173, () => console.log("[WS] UI: http://localhost:5173"));

// --- WebSocket for live audio streaming ---
const wss = new WebSocketServer({ server: http, path: "/audio-stream" });
import { createWriteStream, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

// Helper: buffer and process audio chunks
function bufferToFile(buffer: Buffer, ext = ".wav") {
  const tmpPath = joinPath(tmpdir(), `liveaudio-${Date.now()}${Math.random().toString(36).slice(2)}${ext}`);
  writeFileSync(tmpPath, buffer);
  return tmpPath;
}

// --- Timer-based summarization approach ---
wss.on("connection", ws => {
  let audioBuffers: Buffer[] = [];
  let pcmBuffers: Buffer[] = [];
  let timer: NodeJS.Timeout | null = null;
  let summaryTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let totalBytes = 0;
  let completeTranscript = ""; // Full transcript
  let previousSummary = ""; // Last summary output (for next timer call)

  // Configuration
  let connFormat: string | null = null;
  let connSampleRate = 16000;
  let connChannels = 1;
  let connName: string | null = null;
  let clientChunkMs = 250;
  let summaryWordsPref = 40; // Default to 40 words for timer-based approach
  let connSegmentSeconds = 15;
  let processIntervalMs = 10000; // default to 10s for audio processing
  let summaryIntervalMs = 10000; // default to 10s for summary calls (configurable)

  console.log("[WS] New audio stream connection");

  // Start the summary timer
  function startSummaryTimer() {
    if (summaryTimer) clearInterval(summaryTimer);
    summaryTimer = setInterval(async () => {
      if (closed) return;

      // Get last N words from complete transcript
      const words = completeTranscript.trim().split(/\s+/).filter(w => w.length > 0);
      const lastWords = words.slice(-summaryWordsPref).join(' ');

      if (lastWords.length === 0) {
        console.log('[SUMMARISER] No words to summarize yet');
        return;
      }

      try {
        // Minimal debug: show only the transcript excerpt used and the previous summary
        console.log('[SUMMARISER] INPUT', JSON.stringify({ lastWords, previousSummary }, null, 2));

        const summary = await timerBasedSummarise({
          lastWords,
          previousSummary,
          maxWords: summaryWordsPref
        });

        // Only create a chunk if there's meaningful content
        if (summary.headline && summary.headline.trim()) {
          const chunk: LiveBlogChunk = {
            id: randomUUID(),
            headline: summary.headline,
            bullets: summary.bullets || [],
            quotes: summary.quotes || [],
            entities: summary.entities || [],
            revision_of: null
          };
          broadcast('chunk', chunk);

          // Update previous summary for next call
          previousSummary = `Headline: ${summary.headline}\nBullets: ${summary.bullets.join('; ')}`;
          console.log(`[SUMMARISER] Generated summary: "${summary.headline}"`);
        } else {
          console.log('[SUMMARISER] No new content to summarize');
        }
      } catch (e) {
        console.error('[SUMMARISER] Summary error:', e);
      }
    }, summaryIntervalMs);
  }


  function processBuffer() {
    if (audioBuffers.length === 0 && pcmBuffers.length === 0) return;
    // prefer pcmBuffers if handshake indicated raw PCM
    let fullBuffer: Buffer;
    let tmpFile: string;
    if (pcmBuffers.length > 0 || connFormat === 's16le') {
      fullBuffer = Buffer.concat(pcmBuffers);
      pcmBuffers = [];
      console.log(`[WS] Processing PCM buffer: ${fullBuffer.length} bytes (format=${connFormat})`);
      // write WAV header + PCM data so ffmpeg can read it
      tmpFile = bufferToFile(fullBuffer, '.wav');
      try {
        // overwrite the file with proper WAV header + data
        const bytesPerSample = 2; // s16le
        const blockAlign = connChannels * bytesPerSample;
        const byteRate = connSampleRate * blockAlign;
        const dataSize = fullBuffer.length;
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16); // PCM chunk size
        header.writeUInt16LE(1, 20); // audio format = PCM
        header.writeUInt16LE(connChannels, 22);
        header.writeUInt32LE(connSampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(bytesPerSample * 8, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);
        // write header + pcm
        const combined = Buffer.concat([header, fullBuffer]);
        writeFileSync(tmpFile, combined);
      } catch (e) {
        console.error('[WS] Failed to write WAV file:', e);
        // fall back to raw write
        writeFileSync(tmpFile, fullBuffer);
      }
      console.log(`[WS] Wrote temp audio file (wav): ${tmpFile}`);
    } else {
      fullBuffer = Buffer.concat(audioBuffers);
      audioBuffers = [];
      console.log(`[WS] Processing buffer: ${fullBuffer.length} bytes`);
      // Save to temp file
      tmpFile = bufferToFile(fullBuffer);
      console.log(`[WS] Wrote temp audio file: ${tmpFile}`);
    }

    // Segment and transcribe
    segmentFile(tmpFile, connSegmentSeconds).then(async ({ files }) => {
      console.log(`[WS] Segmented into ${files.length} chunks`);
      let allText = "";
      for (let idx = 0; idx < files.length; idx++) {
        const path = files[idx];
        console.log(`[TRANSCRIPT] Transcribing chunk: ${path}`);
        const { text } = await transcribeChunk(path);
        console.log(`[TRANSCRIPT] Transcription result:`, { text });
        // broadcast each transcript piece as it's produced
        broadcast('transcript_piece', { index: idx, path, text });
        allText += (allText ? " " : "") + text;
      }

      if (allText.trim()) {
        // Append new transcription text to the running transcript
        completeTranscript += (completeTranscript ? " " : "") + allText.trim();
        console.log(`[TRANSCRIPT] Appended transcription to completeTranscript (len=${allText.length})`);
      }

      cleanup(tmpFile);
      try { unlinkSync(tmpFile); } catch { }
    });
  }

  ws.on("message", (data: Buffer | string) => {
    // Handle handshake JSON first (string or JSON buffer)
    try {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg && msg.kind === 'handshake') {
          connFormat = msg.format || null;
          connSampleRate = msg.sampleRate || connSampleRate;
          connChannels = msg.channels || connChannels;
          connName = msg.name || null;
          clientChunkMs = msg.clientChunkMs || clientChunkMs;
          summaryWordsPref = msg.summaryWords || summaryWordsPref;
          connSegmentSeconds = msg.segmentSeconds || connSegmentSeconds;
          processIntervalMs = msg.processIntervalMs || processIntervalMs;

          // New: summary interval configuration
          summaryIntervalMs = msg.summaryIntervalMs || summaryIntervalMs;

          console.log('[WS] Handshake received:', {
            connFormat, connSampleRate, connChannels, connName,
            clientChunkMs, summaryWordsPref,
            connSegmentSeconds, processIntervalMs, summaryIntervalMs
          });

          // Start the summary timer after handshake
          startSummaryTimer();
          return;
        }
      } else if (Buffer.isBuffer(data)) {
        // Check if this is a JSON handshake encoded as buffer
        const s = data.toString('utf8');
        if (s.startsWith('{') && s.indexOf('format') !== -1) {
          try {
            const msg = JSON.parse(s);
            if (msg && msg.kind === 'handshake') {
              connFormat = msg.format || null;
              connSampleRate = msg.sampleRate || connSampleRate;
              connChannels = msg.channels || connChannels;
              connName = msg.name || null;
              clientChunkMs = msg.clientChunkMs || clientChunkMs;
              summaryWordsPref = msg.summaryWords || summaryWordsPref;
              connSegmentSeconds = msg.segmentSeconds || connSegmentSeconds;
              processIntervalMs = msg.processIntervalMs || processIntervalMs;
              summaryIntervalMs = msg.summaryIntervalMs || summaryIntervalMs;

              console.log('[WS] Handshake received (buffer):', {
                connFormat, connSampleRate, connChannels, connName,
                clientChunkMs, summaryWordsPref,
                connSegmentSeconds, processIntervalMs, summaryIntervalMs
              });

              startSummaryTimer();
              return;
            }
          } catch { }
        }
      }

      // Otherwise treat as binary audio payload
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      if (connFormat === 's16le') {
        pcmBuffers.push(buf);
      } else {
        audioBuffers.push(buf);
      }
      totalBytes += buf.length;
    } catch (e) {
      console.error('[WS] Error parsing message:', e);
      return;
    }
    // Process every ~5 seconds of audio (tune as needed)
    if (!timer) {
      timer = setTimeout(() => {
        processBuffer();
        timer = null;
      }, processIntervalMs);
    }
  });

  ws.on("close", () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (summaryTimer) clearInterval(summaryTimer);
    console.log(`[WS] Connection closed. Processing remaining buffer (${audioBuffers.reduce((a, b) => a + b.length, 0)} bytes)`);
    processBuffer();
  });
});

// ---- Simulation pipeline (only if file is provided) ----
if (argv.file) {
  (async () => {
    const { dir, files } = await segmentFile(argv.file as string, argv.chunk);
    console.log(`[TRANSCRIPT] Segmented into ${files.length} chunks of ~${argv.chunk}s`);

    const windowBackSeconds = Math.max(30, argv.chunk * 2); // rolling context
    const transcriptHistory: { start: number; end: number; text: string }[] = [];

    let clock = 0; // simulated seconds position

    for (let i = 0; i < files.length; i++) {
      const path = files[i];
      const start = clock;
      const end = clock + argv.chunk;

      // Simulate playback time (scaled by speed)
      const waitMs = Math.max(0, (argv.chunk * 1000) / argv.speed);
      await new Promise(r => setTimeout(r, waitMs));

      const { text } = await transcribeChunk(path);
      transcriptHistory.push({ start, end, text });

      // Hold-back before we summarise this window
      await new Promise(r => setTimeout(r, argv.hold * 1000));

      // Build rolling window
      const windowStart = Math.max(0, end - windowBackSeconds);
      const windowText = transcriptHistory
        .filter(s => s.end > windowStart)
        .map(s => s.text)
        .join("\n");

      // Minimal debug: show only the transcript window text that will be summarised
      console.log('[LLM INPUT - summariseWindow]', JSON.stringify({ windowText }, null, 2));

      const summary = await summariseWindow({
        transcriptWindow: windowText,
        timeStart: start,
        timeEnd: end
      });

      const chunk: LiveBlogChunk = { id: randomUUID(), ...summary, revision_of: null };
      broadcast("chunk", chunk);

      clock = end;
    }

    cleanup(dir);
    broadcast("eof", { done: true });
    console.log("Done.");
  })();
}