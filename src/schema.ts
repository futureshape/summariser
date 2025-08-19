export type LiveBlogChunk = {
  id: string;
  headline: string;
  bullets: string[];
  quotes?: string[];
  entities?: string[];
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
    revision_of: { type: ["string", "null"] }
    },
  required: ["headline", "bullets", "quotes", "entities", "revision_of"]
  }
} as const;