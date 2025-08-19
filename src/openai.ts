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
  // Only return the transcript text; confidence is not provided by the API.
  return { text: resp.text as string };
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
  // Return parsed summary (no time fields in new shape)
  return parsed;
}

// New approach: timer-based summarization with last N words + previous summary
export async function timerBasedSummarise(params: { 
  lastWords: string; 
  previousSummary: string;
  maxWords?: number;
}) {
  const { lastWords, previousSummary, maxWords = 40 } = params;

  const sys = [
    "You are a live summarizer. You receive:",
    "1. The last few words from a live transcript",
    "2. The output from the previous summarization call (may be empty)",
    "",
    "Rules:",
    "- Only output NEW information that the speaker said, don't repeat what was already summarized adequately in the previous summary",
    "- If there is nothing new or significant to add, return an empty summary (empty headline, empty bullets, etc.)",
    "- When there is new content, be concise and focus on key points",
    "- Use short, clear bullets and headlines",
    "- Output valid JSON matching the schema"
  ].join(" ");

  // Schema for the timer-based response
  const timerSchema = {
    name: "TimerSummary",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        headline: { type: "string" },
        bullets: { type: "array", items: { type: "string" } },
        quotes: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } }
      },
      required: ["headline", "bullets", "quotes", "entities"]
    }
  } as const;

  const contextBits = [
    process.env.CONTEXT_TITLE ? `Talk title: ${process.env.CONTEXT_TITLE}` : "",
    process.env.CONTEXT_SPEAKER ? `Speaker: ${process.env.CONTEXT_SPEAKER}` : "",
  ].filter(Boolean).join("\n");

  const resp = await client.responses.create({
    model: SUMMARISE_MODEL,
    input: [
      { role: "system", content: sys },
      { role: "user", content: [
        { type: "input_text", text: contextBits || "" },
        { type: "input_text", text: `Previous summary:\n${previousSummary || "(none - this is the first call)"}` },
        { type: "input_text", text: `Last ${maxWords} words from transcript:\n${lastWords}` }
      ] }
    ],
    text: {
      format: { name: "json_schema", type: "json_schema", schema: timerSchema.schema }
    }
  });

  // Log what we sent to the LLM (truncated) for debugging
  try {
    console.log('[LLM DEBUG] timerBasedSummarise lastWords length=', lastWords.length, 'previousSummary length=', previousSummary.length);
    console.log('[LLM DEBUG] lastWords preview=', lastWords.replace(/\s+/g, ' ').slice(0, 200));
  } catch {}

  const firstOutput = resp.output?.[0] as any | undefined;
  if (!firstOutput) throw new Error("No response from timer summariser");

  // extract candidate similar to other functions
  let candidate: any = undefined;
  if ("content" in firstOutput) {
    const content = Array.isArray(firstOutput.content) ? firstOutput.content : [firstOutput.content];
    candidate = content[0];
  } else if ("output_text" in firstOutput) {
    candidate = firstOutput.output_text;
  } else if ("text" in firstOutput) {
    candidate = firstOutput.text;
  } else {
    candidate = firstOutput;
  }

  let outText = typeof candidate === 'string' ? candidate : (candidate && candidate.text ? candidate.text : undefined);
  if (!outText) {
    outText = JSON.stringify(firstOutput);
  }

  // Log raw output (truncated) before parsing
  try {
    const rawPreview = (outText as string).replace(/\s+/g, ' ').slice(0, 1000);
    console.log('[LLM DEBUG] timerBasedSummarise raw output preview=', rawPreview);
  } catch {}

  // parse JSON output
  let parsed: any;
  try {
    parsed = JSON.parse(outText as string);
  } catch (e) {
    throw new Error(`Failed to parse timer summariser output as JSON: ${e}`);
  }

  // Expect { headline, bullets, quotes, entities }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Unexpected timer summariser shape');
  }

  return {
    headline: parsed.headline || "",
    bullets: parsed.bullets || [],
    quotes: parsed.quotes || [],
    entities: parsed.entities || []
  };
}

// Keep the old function for backward compatibility during transition
export async function incrementalSummarise(params: { text: string }) {
  // This is the old implementation - keeping for now
  return timerBasedSummarise({ 
    lastWords: params.text.split(' ').slice(-40).join(' '), 
    previousSummary: "" 
  }).then(result => ({
  summaries: result.headline ? [result] : []
  }));
}