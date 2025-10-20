import { getServiceSupabaseClient } from "./supabaseClient.ts";
import { getEmbedding } from "./openai.ts";
import { ScenarioInput, ChunkResult } from "./types.ts";

export function buildQueryFromScenario(scenario: ScenarioInput): string {
  const parts: string[] = [];
  if (scenario.intents?.length) parts.push(scenario.intents.join(" "));
  if (scenario.tooth?.fdi) parts.push(`FDI ${scenario.tooth.fdi}`);
  if (scenario.tooth?.surfaces?.length) parts.push(`surface ${scenario.tooth.surfaces.join("")}`);
  if (scenario.clinical?.reason) parts.push(scenario.clinical.reason);
  if (scenario.clinical?.indications?.length) parts.push(scenario.clinical.indications.join(" "));
  if (!parts.length) parts.push(scenario.raw);
  return parts.join(" ").slice(0, 500);
}

export async function retrieveTopChunks(
  queryText: string,
  matchCount = 3,
): Promise<ChunkResult[]> {
  const trimmed = queryText.trim();
  if (!trimmed) return [];

  const embedding = await getEmbedding(trimmed);
  const client = getServiceSupabaseClient();
  const { data, error } = await client.rpc("match_insurance_chunks", {
    query_embedding: embedding,
    match_count: matchCount,
  });
  if (error) throw error;
  if (!data?.length) return [];

  const docIds = [...new Set(data.map((row: { doc_id: number }) => row.doc_id))];
  const { data: docs, error: docError } = await client.from("insurance_docs")
    .select("id, title")
    .in("id", docIds);
  if (docError) throw docError;
  const titleById = new Map<number, string>();
  for (const doc of docs ?? []) {
    titleById.set(doc.id, doc.title);
  }

  const results = data.map((row: any) => ({
    id: row.id,
    doc_id: row.doc_id,
    chunk_index: row.chunk_index,
    content: row.content,
    similarity: row.similarity ?? 0,
    title: titleById.get(row.doc_id) ?? "알 수 없는 문서",
  }));
  console.log(
    "[retrieveTopChunks] results",
    JSON.stringify(results.map((item) => ({
      doc_id: item.doc_id,
      chunk_index: item.chunk_index,
      similarity: item.similarity,
      preview: item.content.slice(0, 80),
    }))),
  );
  return results;
}
