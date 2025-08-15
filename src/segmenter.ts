
import ffmpeg from "fluent-ffmpeg";
import { rmSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Segments = { dir: string; files: string[]; durationMap: number[] };

export async function segmentFile(input: string, seconds = 15): Promise<Segments> {
  const dir = mkdtempSync(join(tmpdir(), "simsegs-"));
  // -f segment with exact time slices; encode to Opus 16k mono for consistency
  await new Promise<void>((resolve, reject) => {
    ffmpeg(input)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec("libopus")
      .format("ogg")
      .outputOptions([`-f segment`, `-segment_time ${seconds}`, `-reset_timestamps 1`])
      .output(join(dir, "chunk_%05d.ogg"))
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
  const files = readdirSync(dir)
    .filter(f => f.startsWith("chunk_") && f.endsWith(".ogg"))
    .sort();
  const durationMap = files.map(() => seconds);
  return { dir, files: files.map(f => join(dir, f)), durationMap };
}

export function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}