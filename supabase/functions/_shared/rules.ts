import { getServiceSupabaseClient } from "./supabaseClient.ts";
import { ScenarioInput, PlanItem, DenialItem, Citation, HistoryEvent } from "./types.ts";

interface RuleDefinition {
  frequency?: {
    window_days?: number;
    scope?: string;
  };
  age_min?: number;
  same_visit_same_region?: "deny" | "allow";
  allow_exceptions?: string[];
  docs_required?: string[];
}

interface ProcedureRule {
  code: string;
  description: string;
  rule: RuleDefinition;
}

function parseRuleJson(value: unknown): RuleDefinition {
  if (!value || typeof value !== "object") {
    return {};
  }
  const json = value as Record<string, unknown>;
  return {
    frequency: json.frequency && typeof json.frequency === "object"
      ? {
        window_days: typeof (json.frequency as Record<string, unknown>).window_days === "number"
          ? (json.frequency as Record<string, unknown>).window_days as number
          : undefined,
        scope: typeof (json.frequency as Record<string, unknown>).scope === "string"
          ? (json.frequency as Record<string, unknown>).scope as string
          : undefined,
      }
      : undefined,
    age_min: typeof json.age_min === "number" ? json.age_min : undefined,
    same_visit_same_region: typeof json.same_visit_same_region === "string"
      ? json.same_visit_same_region as "deny" | "allow"
      : undefined,
    allow_exceptions: Array.isArray(json.allow_exceptions)
      ? (json.allow_exceptions as unknown[]).filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
      : undefined,
    docs_required: Array.isArray(json.docs_required)
      ? (json.docs_required as unknown[]).filter((value): value is string => typeof value === "string")
      : [],
  };
}

function parseIsoDate(value?: string): Date | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp);
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));
}

function hasSurfaceOverlap(a: string[] = [], b: string[] = []): boolean {
  if (!a.length || !b.length) {
    return true;
  }
  const set = new Set(a);
  return b.some((surface) => set.has(surface));
}

function normalizeReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  return reason.trim().toLowerCase();
}

function checkException(
  scenario: ScenarioInput,
  historyEvent?: HistoryEvent,
  allowList: string[] = [],
): boolean {
  const scenarioReason = normalizeReason(scenario.clinical?.reason);
  if (scenarioReason && allowList.includes(scenarioReason)) {
    return true;
  }
  const historyReason = normalizeReason(historyEvent?.reason);
  if (historyReason && allowList.includes(historyReason)) {
    return true;
  }
  return false;
}

function evaluateFrequency(
  scenario: ScenarioInput,
  rule: RuleDefinition,
): { status: "ok" | "deny" | "insufficient"; reason?: string; event?: HistoryEvent } {
  if (!rule.frequency?.window_days || rule.frequency.scope !== "same_tooth_same_surface") {
    return { status: "ok" };
  }
  const serviceDate = parseIsoDate(scenario.date);
  if (!serviceDate) {
    return { status: "insufficient" };
  }
  const matchingEvents = (scenario.history ?? []).filter((event) =>
    event.tooth?.fdi === scenario.tooth?.fdi &&
    hasSurfaceOverlap(event.tooth?.surfaces ?? [], scenario.tooth?.surfaces ?? [])
  );
  if (!matchingEvents.length) {
    return { status: "ok" };
  }
  const sorted = matchingEvents
    .map((event) => ({ event, eventDate: parseIsoDate(event.date) }))
    .filter((item): item is { event: HistoryEvent; eventDate: Date } => Boolean(item.eventDate))
    .sort((a, b) => b.eventDate.getTime() - a.eventDate.getTime());
  if (!sorted.length) {
    return { status: "insufficient" };
  }
  const latest = sorted[0];
  const difference = daysBetween(serviceDate, latest.eventDate);
  if (difference < rule.frequency.window_days!) {
    const allowList = rule.allow_exceptions ?? [];
    const hasException = checkException(scenario, latest.event, allowList);
    if (hasException) {
      return { status: "ok", event: latest.event };
    }
    return {
      status: "deny",
      reason: `최근 ${rule.frequency.window_days}일 내 동일 부위 수복 이력`,
      event: latest.event,
    };
  }
  return { status: "ok" };
}

function evaluateSameVisit(scenario: ScenarioInput, rule: RuleDefinition, code: string) {
  if (rule.same_visit_same_region !== "deny") {
    return { status: "ok" as const };
  }
  const sameVisitCodes = scenario.visit?.same_visit_codes ?? [];
  if (sameVisitCodes.includes(code)) {
    return {
      status: "deny" as const,
      reason: "동일 내원 동일 부위 중복 청구 불가",
    };
  }
  return { status: "ok" as const };
}

function evaluateAge(scenario: ScenarioInput, rule: RuleDefinition) {
  if (!rule.age_min) {
    return { status: "ok" as const };
  }
  const age = scenario.patient?.age;
  if (typeof age !== "number") {
    return { status: "insufficient" as const };
  }
  if (age < rule.age_min) {
    return {
      status: "deny" as const,
      reason: `만 ${rule.age_min}세 미만`,
    };
  }
  return { status: "ok" as const };
}

export async function fetchProcedureRules(codes: string[]): Promise<ProcedureRule[]> {
  if (!codes.length) {
    return [];
  }
  const client = getServiceSupabaseClient();
  const { data, error } = await client.from("procedures")
    .select("code, description, rules(rule_json)")
    .in("code", codes);
  if (error) {
    throw error;
  }
  return (data ?? []).map((row: any) => ({
    code: row.code,
    description: row.description,
    rule: parseRuleJson(row.rules?.[0]?.rule_json ?? row.rules?.rule_json),
  }));
}

export function evaluateProcedures(
  scenario: ScenarioInput,
  procedures: ProcedureRule[],
  selectCitations: (usage: "allow" | "deny") => Citation[],
): { items: PlanItem[]; denials: DenialItem[]; ok: boolean } {
  const items: PlanItem[] = [];
  const denials: DenialItem[] = [];
  let hasInsufficient = false;

  for (const procedure of procedures) {
    const rule = procedure.rule;

    const ageCheck = evaluateAge(scenario, rule);
    if (ageCheck.status === "insufficient") {
      hasInsufficient = true;
      break;
    }
    if (ageCheck.status === "deny") {
      denials.push({
        reason: ageCheck.reason ?? "연령 기준 미충족",
        citations: selectCitations("deny"),
      });
      continue;
    }

    const visitCheck = evaluateSameVisit(scenario, rule, procedure.code);
    if (visitCheck.status === "deny") {
      denials.push({
        reason: visitCheck.reason ?? "동일 내원 내 중복 청구 제한",
        citations: selectCitations("deny"),
      });
      continue;
    }

    const frequencyCheck = evaluateFrequency(scenario, rule);
    if (frequencyCheck.status === "insufficient") {
      hasInsufficient = true;
      break;
    }
    if (frequencyCheck.status === "deny") {
      denials.push({
        reason: frequencyCheck.reason ?? "빈도 제한 초과",
        citations: selectCitations("deny"),
      });
      continue;
    }

    const docsRequired = rule.docs_required ?? [];
    items.push({
      procedure_code: procedure.code,
      description: procedure.description,
      tooth: scenario.tooth ?? {},
      quantity: 1,
      reason: scenario.clinical?.reason
        ? scenario.clinical.reason
        : "임상 사유 미기재",
      docs_required: docsRequired,
      citations: selectCitations("allow"),
    });
  }

  return {
    ok: !hasInsufficient && (!!items.length || !!denials.length),
    items,
    denials,
  };
}
