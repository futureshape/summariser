import OpenAI from "openai";
import dotenv from "dotenv";
import { createReadStream } from "node:fs";
import type { LiveBlogChunk } from "./schema.js";
import { jsonSchema } from "./schema.js";

dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe"; // fallback to whisper-1 if needed
const SUMMARISE_MODEL = process.env.SUMMARISE_MODEL || "gpt-4o-mini";

export async function transcribeChunk(path: string) {
  const resp = await client.audio.transcriptions.create({
    file: createReadStream(path) as any,
    model: TRANSCRIBE_MODEL
  });
  // resp.text only; confidence not exposed → we proxy confidence via heuristic
  return { text: resp.text as string, confidence: heuristicConfidence(resp.text as string) };
}

function heuristicConfidence(text: string): number {
  // Very rough: longer, more punctuated text ⇒ higher confidence
  const len = text.trim().split(/\s+/).length;
  const punc = (text.match(/[\.,;:!?]/g) || []).length;
  return Math.max(0.4, Math.min(0.98, 0.45 + len/200 + punc/50));
}

export async function summariseWindow(params: {
  transcriptWindow: string;
  timeStart: number;
  timeEnd: number;
}) : Promise<Omit<LiveBlogChunk, "id">> {
  const { transcriptWindow, timeStart, timeEnd } = params;

  const sys = [
    "You are a live-blog note-taker.",
    "Summarise only what the speaker actually said in this window.",
    "If a name/number is unclear, write [unclear].",
    "Prefer short, verb-led bullets.",
    "Do not invent facts from context; use context only to disambiguate terms.",
  ].join(" ");

  const contextBits = [
    process.env.CONTEXT_TITLE ? `Talk title: ${process.env.CONTEXT_TITLE}` : "",
    process.env.CONTEXT_SPEAKER ? `Speaker: ${process.env.CONTEXT_SPEAKER}` : "",
    process.env.CONTEXT_ABSTRACT ? `Abstract: ${process.env.CONTEXT_ABSTRACT}` : ""
  ].filter(Boolean).join("\n");

  const resp = await client.responses.create({
    model: SUMMARISE_MODEL,
    input: [
      { role: "system", content: sys },
      { role: "user", content: [
        { type: "input_text", text: contextBits || "" },
        { type: "input_text", text: `Transcript [${timeStart.toFixed(1)}–${timeEnd.toFixed(1)}s]:\n${transcriptWindow}` }
      ] }
    ],
    text: {
      format: { name: "json_schema", type: "json_schema", schema: jsonSchema.schema }
    }
  });

  // Normalize the response output to an object with { type?: string, text: string }
  type OutputObj = { type?: string; text: string };

  let outObj: OutputObj | undefined;
  const firstOutput = resp.output?.[0] as any | undefined;
  if (firstOutput) {
    // Candidate extraction logic to handle multiple SDK shapes
    let candidate: any = undefined;

    if ("content" in firstOutput) {
      // content might be an array or a single item
      const content = Array.isArray(firstOutput.content) ? firstOutput.content : [firstOutput.content];
      candidate = content[0];
    } else if ("output_text" in firstOutput) {
      candidate = firstOutput.output_text;
    } else if ("text" in firstOutput) {
      candidate = firstOutput.text;
    } else {
      candidate = firstOutput;
    }

    // Candidate can be:
    // - a simple string (the output text)
    // - an object like { type: 'output_text', text: '...' }
    // - a nested object with content array containing the above
    if (typeof candidate === "string") {
      outObj = { type: "output_text", text: candidate };
    } else if (candidate && typeof candidate === "object") {
      if ("text" in candidate && typeof candidate.text === "string") {
        outObj = { type: candidate.type ?? "output_text", text: candidate.text };
      } else if ("content" in candidate) {
        const inner = Array.isArray(candidate.content) ? candidate.content[0] : candidate.content;
        if (typeof inner === "string") outObj = { type: "output_text", text: inner };
        else if (inner && typeof inner === "object" && "text" in inner) outObj = { type: inner.type ?? "output_text", text: inner.text };
      }
    }
  }

  if (!outObj) throw new Error("Unexpected response shape: no textual output found");
  if (outObj.type !== "output_text") throw new Error("Unexpected response shape: output not of type 'output_text'");

  const parsed = JSON.parse(outObj.text) as Omit<LiveBlogChunk, "id">;
  // Ensure the model uses the time window we passed
  return { ...parsed, time_start: timeStart, time_end: timeEnd };
}