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
  // Ensure the model uses the time window we passed
  return { ...parsed, time_start: timeStart, time_end: timeEnd };
}

// Incremental summarisation: summarise as many complete thoughts as possible
// and return the remaining trailing unsummarised text.
export async function incrementalSummarise(params: { text: string }) {
  const { text } = params;

  const sys = [
    "You receive a live transcript (may end with an incomplete trailing fragment). Produce a JSON object matching the schema: { summaries: [...], remaining: \"\" } and nothing else.",
    "Rules:",
    "- Only summarize complete sentences or complete thoughts that end in sentence punctuation (. ? !) or an obvious sentence boundary (newline plus capital). Do not attempt to summarize an incomplete trailing fragment.",
    "- The \"remaining\" field must be exactly the trailing substring of the original transcript that is incomplete and unsummarised. It must be a literal suffix of the input text. If there is no trailing incomplete fragment, set \"remaining\" to an empty string \"\".",
    "- Do NOT include any earlier or already-summarised content inside \"remaining\". Do NOT echo the start of the input inside \"remaining\".",
  "- When producing summaries, prefer short verb-led bullets and a short headline per summary item.",
    "- Output only valid JSON exactly matching the schema; do not add prose, explanation, or extra keys."
  ].join(" ");

  // Schema for the incremental response
  const incrementalSchema = {
    name: "Incremental",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summaries: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              headline: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              quotes: { type: "array", items: { type: "string" } },
              entities: { type: "array", items: { type: "string" } }
            },
            // validator requires 'required' to include every property when additionalProperties is false
            required: ["headline", "bullets", "quotes", "entities"]
          }
        },
        remaining: { type: "string" }
      },
      required: ["summaries", "remaining"]
    }
  } as const;

  const contextBits = [
    process.env.CONTEXT_TITLE ? `Talk title: ${process.env.CONTEXT_TITLE}` : "",
    process.env.CONTEXT_SPEAKER ? `Speaker: ${process.env.CONTEXT_SPEAKER}` : "",
  ].filter(Boolean).join("\n");

  // Provide two concrete examples to make the required behaviour explicit.
  const exampleAOut = {
    summaries: [
      { headline: "Project funded", bullets: ["Team will fund the project"], quotes: [], entities: [] },
      { headline: "Timeline", bullets: ["Expect six-month timeline, start in June"], quotes: [], entities: [] }
    ],
    remaining: "Budget details are still..."
  };
  const exampleBOut = { summaries: [], remaining: "Budget details are still being reviewed and we might need" };

  const examplesText = [
    "Examples:",
    "Input A:",
    "We will fund the project. The timeline is six months and we expect to start in June. Budget details are still...",
    "Expected Output A:",
    JSON.stringify(exampleAOut),
    "",
    "Input B:",
    "Budget details are still being reviewed and we might need",
    "Expected Output B:",
    JSON.stringify(exampleBOut)
  ].join("\n");

  const resp = await client.responses.create({
    model: SUMMARISE_MODEL,
    input: [
      { role: "system", content: sys },
      { role: "user", content: [
        { type: "input_text", text: contextBits || "" },
        { type: "input_text", text: examplesText },
        { type: "input_text", text: `Transcript (may contain incomplete trailing fragment):\n${text}` }
      ] }
    ],
    text: {
      format: { name: "json_schema", type: "json_schema", schema: incrementalSchema.schema }
    }
  });

  // Log what we sent to the LLM (truncated) for debugging
  try {
    const preview = (text || '').replace(/\s+/g, ' ').slice(0, 1000);
    console.log('[LLM DEBUG] incrementalSummarise input length=', (text || '').length, 'preview=', preview);
  } catch {}

  const firstOutput = resp.output?.[0] as any | undefined;
  if (!firstOutput) throw new Error("No response from summariser");

  // extract candidate similar to summariseWindow
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
    // try stringify whole firstOutput
    outText = JSON.stringify(firstOutput);
  }

  // Log raw output (truncated) before parsing
  try {
    const rawPreview = (outText as string).replace(/\s+/g, ' ').slice(0, 1500);
    console.log('[LLM DEBUG] incrementalSummarise raw output preview=', rawPreview);
  } catch {}

  // parse JSON output
  let parsed: any;
  try {
    parsed = JSON.parse(outText as string);
  } catch (e) {
    throw new Error(`Failed to parse incremental summariser output as JSON: ${e}`);
  }

  // Expect { summaries: [...], remaining: '...' }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.summaries) || typeof parsed.remaining !== 'string') {
    throw new Error('Unexpected incremental summariser shape');
  }

  return { summaries: parsed.summaries as any[], remaining: parsed.remaining as string };
}