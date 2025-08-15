import express from "express";
import { createServer } from "node:http";
import { segmentFile, cleanup } from "./segmenter.js";
import { transcribeChunk, summariseWindow } from "./openai.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveBlogChunk } from "./schema.js";

const argv = await yargs(hideBin(process.argv))
  .option("file", { type: "string", demandOption: true, describe: "Path to audio file" })
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

// ---- Simulation pipeline ----

(async () => {
  const { dir, files } = await segmentFile(argv.file, argv.chunk);
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