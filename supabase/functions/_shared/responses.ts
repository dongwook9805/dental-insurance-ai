import { ClaimResponseBody } from "./types.ts";

const NO_DATA_TEXT = "데이터에 없음";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function noDataResponseBody(): ClaimResponseBody {
  return {
    ok: false,
    billable: false,
    items: [],
    denials: [],
    explanations: NO_DATA_TEXT,
  };
}

export function buildResponseBody(
  params: Partial<ClaimResponseBody> & { items: ClaimResponseBody["items"]; denials: ClaimResponseBody["denials"] },
): ClaimResponseBody {
  return {
    ok: params.ok ?? true,
    billable: params.billable ?? params.items.length > 0,
    items: params.items,
    denials: params.denials,
    explanations: params.explanations ?? "",
  };
}

export function jsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

export const NO_DATA_MESSAGE = NO_DATA_TEXT;
