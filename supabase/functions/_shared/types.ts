export interface ToothInfo {
  fdi?: number;
  surfaces?: string[];
}

export interface HistoryEvent {
  code?: string;
  date?: string;
  tooth?: ToothInfo;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ScenarioInput {
  raw: string;
  date?: string;
  patient?: {
    age?: number;
  };
  tooth?: ToothInfo;
  visit?: {
    same_visit_codes?: string[];
  };
  history?: HistoryEvent[];
  clinical?: {
    indications?: string[];
    reason?: string;
  };
  intents?: string[];
  meta?: Record<string, unknown>;
}

export interface Citation {
  title: string;
  chunk_index: number;
}

export interface PlanItem {
  procedure_code: string;
  description: string;
  tooth: ToothInfo;
  quantity: number;
  reason: string;
  docs_required: string[];
  citations: Citation[];
}

export interface DenialItem {
  reason: string;
  citations: Citation[];
}

export interface ClaimResponseBody {
  ok: boolean;
  billable: boolean;
  items: PlanItem[];
  denials: DenialItem[];
  explanations: string;
}

export interface ChunkResult {
  id: number;
  doc_id: number;
  chunk_index: number;
  content: string;
  similarity: number;
  title: string;
}
