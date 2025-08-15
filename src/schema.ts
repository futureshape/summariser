export type LiveBlogChunk = {
  id: string;
  headline: string;
  bullets: string[];
  quotes?: string[];
  entities?: string[];
  time_start: number; // seconds in original file
  time_end: number;   // seconds in original file
  confidence: number; // 0..1 (proxy from ASR)
  revision_of?: string | null;
};

export const jsonSchema = {
  name: "LiveBlogChunk",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      headline: { type: "string" },
      bullets: { type: "array", items: { type: "string" }, maxItems: 5 },
      quotes: { type: "array", items: { type: "string" } },
      entities: { type: "array", items: { type: "string" } },
      time_start: { type: "number" },
      time_end: { type: "number" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      revision_of: { type: ["string", "null"] }
    },
  required: ["headline", "bullets", "quotes", "entities", "time_start", "time_end", "confidence", "revision_of"]
  }
} as const;