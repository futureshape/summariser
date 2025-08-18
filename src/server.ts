import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { segmentFile, cleanup } from "./segmenter.js";
import { transcribeChunk, summariseWindow } from "./openai.js";
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
  req.on("close", () => { clients.forEach(c => c.id===id && clients.delete(c)); });
});

function broadcast(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.res.write(payload);
}


http.listen(5173, () => console.log("UI: http://localhost:5173"));

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

// --- DEBUG LOGGING for live audio streaming with sentence accumulation ---
wss.on("connection", ws => {
  let audioBuffers: Buffer[] = [];
  let pcmBuffers: Buffer[] = [];
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let totalBytes = 0;
  let accumulatedText = "";
  let avgConfidence: number[] = [];
  let connFormat: string | null = null;
  let connSampleRate = 16000;
  let connChannels = 1;
  let connName: string | null = null;
  let clientChunkMs = 250;
  let summaryWordsPref = 20;
  let summarySentencesPref = 2;
  let connSegmentSeconds = 15;
  console.log("[WS] New audio stream connection");

  // Helper: split text into sentences (returns {complete, incomplete})
  function splitSentences(text: string): { complete: string[], incomplete: string } {
    // Regex for sentence boundaries (handles . ! ?)
    const matches = text.match(/[^.!?\n]+[.!?]+/g) || [];
    const lastIndex = matches.reduce((idx, s) => idx + s.length, 0);
    const incomplete = text.slice(lastIndex).trim();
    return { complete: matches.map(s => s.trim()), incomplete };
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
      let confidences: number[] = [];
      for (const path of files) {
        console.log(`[WS] Transcribing chunk: ${path}`);
        const { text, confidence } = await transcribeChunk(path);
        console.log(`[WS] Transcription result:`, { text, confidence });
        allText += (allText ? " " : "") + text;
        confidences.push(confidence);
      }
      const avgConf = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0.8;
      // Accumulate all text so far
      accumulatedText += (accumulatedText ? " " : "") + allText;
      avgConfidence.push(...confidences);
      // Split into sentences, keep incomplete for next round
      const { complete, incomplete } = splitSentences(accumulatedText);
      console.log(`[WS] Current complete sentences:`, JSON.stringify(complete));
      console.log(`[WS] Current incomplete:`, JSON.stringify(incomplete));

      // Only summarise when enough sentences/words are accumulated
      let i = 0;
      while (i < complete.length) {
        // Group sentences for chunk
  let chunkSentences: string[] = [];
  let wordCount = 0;
  while (i < complete.length && (wordCount < summaryWordsPref && chunkSentences.length < summarySentencesPref)) {
          chunkSentences.push(complete[i]);
          wordCount += complete[i].split(/\s+/).length;
          i++;
        }
        if (chunkSentences.length === 0) break;
        console.log(`[WS] Buffer state: ${complete.length} sentences, ${wordCount} words`);
        // Summarise this chunk
        const groupText = chunkSentences.join(" ").trim();
        const conf = avgConfidence.length ? avgConfidence.splice(0, chunkSentences.length).reduce((a, b) => a + b, 0) / chunkSentences.length : avgConf;
        console.log(`[WS] Summarisation input:`, groupText);
        const summary = await summariseWindow({ transcriptWindow: groupText, timeStart: 0, timeEnd: 0 });
        summary.confidence = conf;
        console.log(`[WS] Summarisation result:`, summary);
        const chunk: LiveBlogChunk = { id: randomUUID(), ...summary };
        broadcast("chunk", chunk);
      }
      // Keep only the incomplete sentence for next round
      accumulatedText = incomplete;
  cleanup(tmpFile);
  try { unlinkSync(tmpFile); } catch {}
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
          summarySentencesPref = msg.summarySentences || summarySentencesPref;
          connSegmentSeconds = msg.segmentSeconds || connSegmentSeconds;
          console.log('[WS] Handshake received:', { connFormat, connSampleRate, connChannels, connName, clientChunkMs, summaryWordsPref, summarySentencesPref, connSegmentSeconds });
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
              summarySentencesPref = msg.summarySentences || summarySentencesPref;
              connSegmentSeconds = msg.segmentSeconds || connSegmentSeconds;
              console.log('[WS] Handshake received (buffer):', { connFormat, connSampleRate, connChannels, connName, clientChunkMs, summaryWordsPref, summarySentencesPref, connSegmentSeconds });
              return;
            }
          } catch {}
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
      }, 5000);
    }
  });

  ws.on("close", () => {
    closed = true;
    if (timer) clearTimeout(timer);
    console.log(`[WS] Connection closed. Processing remaining buffer (${audioBuffers.reduce((a,b)=>a+b.length,0)} bytes)`);
    processBuffer();
  });
});

// ---- Simulation pipeline (only if file is provided) ----
if (argv.file) {
  (async () => {
    const { dir, files } = await segmentFile(argv.file as string, argv.chunk);
    console.log(`Segmented into ${files.length} chunks of ~${argv.chunk}s`);

    const windowBackSeconds = Math.max(30, argv.chunk * 2); // rolling context
    const transcriptHistory: { start: number; end: number; text: string; conf: number }[] = [];

    let clock = 0; // simulated seconds position

    for (let i = 0; i < files.length; i++) {
      const path = files[i];
      const start = clock;
      const end = clock + argv.chunk;

      // Simulate playback time (scaled by speed)
      const waitMs = Math.max(0, (argv.chunk * 1000) / argv.speed);
      await new Promise(r => setTimeout(r, waitMs));

      const { text, confidence } = await transcribeChunk(path);
      transcriptHistory.push({ start, end, text, conf: confidence });

      // Hold-back before we summarise this window
      await new Promise(r => setTimeout(r, argv.hold * 1000));

      // Build rolling window
      const windowStart = Math.max(0, end - windowBackSeconds);
      const windowText = transcriptHistory
        .filter(s => s.end > windowStart)
        .map(s => s.text)
        .join("\n");

      const summary = await summariseWindow({
        transcriptWindow: windowText,
        timeStart: start,
        timeEnd: end
      });

      const chunk: LiveBlogChunk = { id: randomUUID(), ...summary };
      broadcast("chunk", chunk);

      clock = end;
    }

    cleanup(dir);
    broadcast("eof", { done: true });
    console.log("Done.");
  })();
}