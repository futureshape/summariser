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

// --- DEBUG LOGGING for live audio streaming ---
wss.on("connection", ws => {
  let audioBuffers: Buffer[] = [];
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let totalBytes = 0;
  console.log("[WS] New audio stream connection");

  function processBuffer() {
    if (audioBuffers.length === 0) return;
    const fullBuffer = Buffer.concat(audioBuffers);
    audioBuffers = [];
    console.log(`[WS] Processing buffer: ${fullBuffer.length} bytes`);
    // Save to temp file
    const tmpFile = bufferToFile(fullBuffer);
    console.log(`[WS] Wrote temp audio file: ${tmpFile}`);
    // Segment and transcribe
    segmentFile(tmpFile, 15).then(async ({ files }) => {
      console.log(`[WS] Segmented into ${files.length} chunks`);
      for (const path of files) {
        console.log(`[WS] Transcribing chunk: ${path}`);
        const { text, confidence } = await transcribeChunk(path);
        console.log(`[WS] Transcription result:`, { text, confidence });
        // Summarise
        const summary = await summariseWindow({ transcriptWindow: text, timeStart: 0, timeEnd: 0 });
        console.log(`[WS] Summarisation result:`, summary);
        const chunk: LiveBlogChunk = { id: randomUUID(), ...summary };
        broadcast("chunk", chunk);
      }
      cleanup(tmpFile);
      try { unlinkSync(tmpFile); } catch {}
    });
  }

  ws.on("message", (data: Buffer) => {
    audioBuffers.push(Buffer.from(data));
    totalBytes += data.length;
    console.log(`[WS] Received audio chunk: ${data.length} bytes (total: ${totalBytes})`);
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