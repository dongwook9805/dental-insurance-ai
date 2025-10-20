import { ScenarioInput, ToothInfo, HistoryEvent } from "./types.ts";

const SURFACE_REGEX = /\b([DOMBLRX]+)\b/iu;
const FDI_REGEX = /\b([1-4][1-8])\b/;

function normalizeSurfaces(surfaces?: unknown): string[] {
  if (!Array.isArray(surfaces)) {
    return [];
  }
  return surfaces
    .map((item) => (typeof item === "string" ? item.toUpperCase() : ""))
    .filter((value, index, array) => value && array.indexOf(value) === index);
}

function parseHistory(history?: unknown): HistoryEvent[] {
  if (!Array.isArray(history)) {
    return [];
  }
  return history.map((entry) => {
    const event = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const tooth = event.tooth && typeof event.tooth === "object"
      ? event.tooth as Record<string, unknown>
      : {};
    const toothInfo: ToothInfo = {
      fdi: typeof tooth.fdi === "number" ? tooth.fdi : undefined,
      surfaces: normalizeSurfaces(tooth.surfaces),
    };
    return {
      code: typeof event.code === "string" ? event.code : undefined,
      date: typeof event.date === "string" ? event.date : undefined,
      tooth: toothInfo,
      reason: typeof event.reason === "string" ? event.reason : undefined,
      metadata: event.metadata && typeof event.metadata === "object"
        ? event.metadata as Record<string, unknown>
        : undefined,
    };
  }).filter((event) => event.code || event.date || event.reason);
}

function inferFromText(text: string): ScenarioInput {
  const lower = text.toLowerCase();
  const scenario: ScenarioInput = {
    raw: text,
    tooth: {},
    clinical: {},
    history: [],
    intents: [],
  };

  const fdiMatch = text.match(FDI_REGEX);
  if (fdiMatch) {
    scenario.tooth = { fdi: Number(fdiMatch[1]) };
  }

  const surfaceMatch = text.match(SURFACE_REGEX);
  if (surfaceMatch && surfaceMatch[1]) {
    scenario.tooth = scenario.tooth ?? {};
    scenario.tooth.surfaces = surfaceMatch[1].toUpperCase().split("");
  }

  if (/fracture|파절|골절/iu.test(lower)) {
    scenario.clinical = { reason: "fracture" };
  } else if (/secondary[\s_-]?caries|2차[ ]?우식/iu.test(lower)) {
    scenario.clinical = { reason: "secondary_caries" };
  } else {
    scenario.clinical = { reason: text.slice(0, 100).trim() };
  }

  if (/크라운|crown|cr/i.test(text)) {
    scenario.intents = ["CRN_POST_MOLAR"];
  }

  return scenario;
}

export function parseScenario(rawBody: string): ScenarioInput | null {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (!parsed) {
    const inferred = inferFromText(trimmed);
    if (!inferred.tooth?.fdi || !inferred.intents?.length) {
      return null;
    }
    inferred.raw = trimmed;
    return inferred;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const body = parsed as Record<string, unknown>;
  const scenario: ScenarioInput = {
    raw: trimmed,
    date: typeof body.date === "string" ? body.date : undefined,
    patient: body.patient && typeof body.patient === "object"
      ? { age: typeof (body.patient as Record<string, unknown>).age === "number" ? (body.patient as Record<string, unknown>).age as number : undefined }
      : undefined,
    tooth: body.tooth && typeof body.tooth === "object"
      ? {
        fdi: typeof (body.tooth as Record<string, unknown>).fdi === "number" ? (body.tooth as Record<string, unknown>).fdi as number : undefined,
        surfaces: normalizeSurfaces((body.tooth as Record<string, unknown>).surfaces),
      }
      : undefined,
    visit: body.visit && typeof body.visit === "object"
      ? {
        same_visit_codes: Array.isArray((body.visit as Record<string, unknown>).same_visit_codes)
          ? ((body.visit as Record<string, unknown>).same_visit_codes as unknown[])
            .filter((value): value is string => typeof value === "string")
          : undefined,
      }
      : undefined,
    history: parseHistory(body.history),
    clinical: body.clinical && typeof body.clinical === "object"
      ? {
        indications: Array.isArray((body.clinical as Record<string, unknown>).indications)
          ? ((body.clinical as Record<string, unknown>).indications as unknown[])
            .filter((value): value is string => typeof value === "string")
          : undefined,
        reason: typeof (body.clinical as Record<string, unknown>).reason === "string"
          ? (body.clinical as Record<string, unknown>).reason as string
          : undefined,
      }
      : undefined,
    intents: Array.isArray(body.intents)
      ? (body.intents as unknown[]).filter((value): value is string => typeof value === "string")
      : undefined,
    meta: body.meta && typeof body.meta === "object"
      ? body.meta as Record<string, unknown>
      : undefined,
  };

  if (!scenario.intents?.length && /크라운|crown|cr/i.test(trimmed)) {
    scenario.intents = ["CRN_POST_MOLAR"];
  }

  if (!scenario.clinical?.reason && scenario.meta?.reason && typeof scenario.meta.reason === "string") {
    scenario.clinical = {
      ...(scenario.clinical ?? {}),
      reason: scenario.meta.reason,
    };
  }

  if (!scenario.tooth?.fdi || !scenario.intents?.length) {
    return null;
  }

  scenario.tooth.surfaces = scenario.tooth.surfaces ?? [];
  return scenario;
}
