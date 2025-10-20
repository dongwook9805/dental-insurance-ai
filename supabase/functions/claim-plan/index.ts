import { parseScenario } from "../_shared/parsing.ts";
import { buildQueryFromScenario, retrieveTopChunks, mapChunksToCitations } from "../_shared/retrieval.ts";
import { fetchProcedureRules, evaluateProcedures } from "../_shared/rules.ts";
import { getGroundedSummary } from "../_shared/openai.ts";
import { getServiceSupabaseClient } from "../_shared/supabaseClient.ts";
import { jsonResponse, noDataResponseBody, buildResponseBody, NO_DATA_MESSAGE, CORS_HEADERS } from "../_shared/responses.ts";
import { ScenarioInput, ClaimResponseBody, ChunkResult, Citation } from "../_shared/types.ts";

function selectCitationsFactory(chunks: ChunkResult[]) {
  const allowPreferred = chunks.filter((chunk) =>
    /예외|인정|fracture|secondary_caries/iu.test(chunk.content)
  );
  const denyPreferred = chunks.filter((chunk) =>
    /불인정|제한|deny/iu.test(chunk.content)
  );

  const fallback = mapChunksToCitations(chunks.slice(0, 1));

  const select = (usage: "allow" | "deny"): Citation[] => {
    const pool = usage === "allow" ? allowPreferred : denyPreferred;
    if (!pool.length && !chunks.length) {
      return [];
    }
    const selected = pool.length ? pool : chunks.slice(0, 1);
    return mapChunksToCitations(selected.slice(0, 1));
  };

  return (usage: "allow" | "deny"): Citation[] => {
    const result = select(usage);
    return result.length ? result : fallback;
  };
}

async function handleRequest(req: Request): Promise<Response> {
  const bodyText = await req.text();
  const scenario = parseScenario(bodyText);
  if (!scenario) {
    return jsonResponse(noDataResponseBody(), 400);
  }

  const queryText = buildQueryFromScenario(scenario);
  let chunks: ChunkResult[];
  try {
    chunks = await retrieveTopChunks(queryText);
  } catch (error) {
    console.error("chunk retrieval failed", error);
    return jsonResponse(noDataResponseBody(), 500);
  }
  if (!chunks.length) {
    return jsonResponse(noDataResponseBody(), 404);
  }

  const selectCitations = selectCitationsFactory(chunks);

  const procedureCodes = scenario.intents ?? [];
  let procedures;
  try {
    procedures = await fetchProcedureRules(procedureCodes);
  } catch (error) {
    console.error("rule fetch failed", error);
    return jsonResponse(noDataResponseBody(), 500);
  }
  if (procedures.length !== procedureCodes.length) {
    return jsonResponse(noDataResponseBody(), 404);
  }

  const evaluation = evaluateProcedures(scenario, procedures, selectCitations);
  if (!evaluation.ok) {
    return jsonResponse(noDataResponseBody(), 422);
  }

  let explanation = "";
  try {
    const contextText = chunks
      .map((chunk) => `[${chunk.title} #${chunk.chunk_index}] ${chunk.content}`)
      .join("\n");
    explanation = await getGroundedSummary(
      contextText,
      "위 시나리오에 대한 보험 청구 판단을 간단히 설명하세요.",
    );
  } catch (error) {
    console.error("summary failed", error);
    return jsonResponse(noDataResponseBody(), 500);
  }

  const responseBody: ClaimResponseBody = buildResponseBody({
    ok: true,
    billable: evaluation.items.length > 0,
    items: evaluation.items,
    denials: evaluation.denials,
    explanations: explanation || NO_DATA_MESSAGE,
  });

  const { raw: _raw, ...scenarioLog } = scenario as ScenarioInput & { raw?: string };
  const client = getServiceSupabaseClient();
  client.from("query_logs")
    .insert({
      scenario_json: scenarioLog,
      outcome: responseBody.billable ? "billable" : "non_billable",
    })
    .then((result) => {
      if (result.error) {
        console.error("log insert failed", result.error);
      }
    })
    .catch((error) => console.error("log insert error", error));

  return jsonResponse(responseBody);
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
    console.error("claim-plan fatal error", error);
    return jsonResponse(noDataResponseBody(), 500);
  }
});
