import { retrieveTopChunks } from "../_shared/retrieval.ts";
import { getGroundedSummary } from "../_shared/openai.ts";
import { jsonResponse, NO_DATA_MESSAGE, CORS_HEADERS } from "../_shared/responses.ts";

interface RagResponse {
  ok: boolean;
  answer: string;
  citations: string[];
}

function serializeCitations(chunks: { title: string; chunk_index: number }[]): string[] {
  return chunks.map((chunk) => `[${chunk.title} #${chunk.chunk_index}]`);
}

async function handleRequest(req: Request): Promise<Response> {
  const bodyText = await req.text();
  let query = bodyText.trim();

  if (query.startsWith("{")) {
    try {
      const parsed = JSON.parse(query);
      if (parsed && typeof parsed === "object" && typeof parsed.query === "string") {
        query = parsed.query.trim();
      } else if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
        query = parsed.text.trim();
      }
    } catch {
      // ignore parse errors; fall back to raw text
    }
  }

  if (!query) {
    const failure: RagResponse = { ok: false, answer: NO_DATA_MESSAGE, citations: [] };
    return jsonResponse(failure as any, 400);
  }

  const chunks = await retrieveTopChunks(query, 3);
  if (!chunks.length) {
    const notFound: RagResponse = { ok: false, answer: NO_DATA_MESSAGE, citations: [] };
    return jsonResponse(notFound as any, 404);
  }

  const contextSegments: string[] = [];
  let totalChars = 0;
  for (const chunk of chunks) {
    const normalized = chunk.content.replace(/\s+/g, " ").trim();
    const segmentBody = normalized.slice(0, 1200);
    const segment = `[${chunk.title} #${chunk.chunk_index}] ${segmentBody}`;
    if (totalChars + segment.length > 3600 && contextSegments.length) {
      break;
    }
    contextSegments.push(segment);
    totalChars += segment.length;
  }
  const contextText = contextSegments.join("\n");

  const buildFallbackSummary = () => {
    const primary = chunks[0];
    const normalized = primary.content.replace(/\s+/g, " ").trim();
    const docRefMatch = normalized.match(/\[(?:고시|보건복지부|건강보험)[^\]]*\]/);
    const docRef = docRefMatch ? docRefMatch[0] : `[${primary.title} #${primary.chunk_index}]`;
    return `데이터 부족 — 상위 문단을 참고하세요. ${docRef}`;
  };

  let summary: string;
  try {
    summary = await getGroundedSummary(contextText, query);
    if (!summary) {
      summary = buildFallbackSummary();
    }
  } catch (error) {
    console.warn("getGroundedSummary failed, using fallback summary", error);
    summary = buildFallbackSummary();
  }

  const citationEntries = chunks.map((chunk, idx) => {
    const normalized = chunk.content.replace(/\s+/g, " ").trim();
    const docRefMatch = normalized.match(/\[(?:고시|보건복지부|건강보험)[^\]]*\]/);
    const docRef = docRefMatch ? docRefMatch[0] : `[${chunk.title} #${chunk.chunk_index}]`;
    return {
      label: `[${idx + 1}]`,
      ref: docRef,
    };
  });

  const summaryWithRefs = citationEntries.length
    ? `${summary} ${citationEntries.map((entry) => entry.label).join(" ")}`.trim()
    : summary.trim();

  const formattedCitations = citationEntries
    .map((entry) => `${entry.label} ${entry.ref}`)
    .join("\n");

  const answerParts = [summaryWithRefs];
  if (formattedCitations) {
    answerParts.push(`[인용]\n${formattedCitations}`);
  }
  const answer = answerParts.join("\n\n").trim();
  const citations = serializeCitations(chunks);
  const response: RagResponse = {
    ok: true,
    answer,
    citations,
  };
  return jsonResponse(response as any);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  }
  try {
    return await handleRequest(req);
  } catch (error) {
    console.error("rag-answer fatal error", error);
    const failure: RagResponse = { ok: false, answer: NO_DATA_MESSAGE, citations: [] };
    return jsonResponse(failure as any, 500);
  }
});
