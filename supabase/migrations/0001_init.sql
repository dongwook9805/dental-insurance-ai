-- Enable required extensions
create extension if not exists vector;

-- Source documents for insurance guidance
create table if not exists insurance_docs (
  id bigserial primary key,
  title text not null,
  source text,
  created_at timestamptz not null default now()
);

-- Chunked embeddings for RAG search
create table if not exists insurance_chunks (
  id bigserial primary key,
  doc_id bigint not null references insurance_docs(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(1536) not null,
  constraint insurance_chunks_unique unique (doc_id, chunk_index)
);

create index if not exists insurance_chunks_doc_idx on insurance_chunks(doc_id);
create index if not exists insurance_chunks_embedding_idx on insurance_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Procedure catalog
create table if not exists procedures (
  code text primary key,
  description text not null,
  created_at timestamptz not null default now()
);

-- Deterministic coverage rules per procedure
create table if not exists rules (
  id bigserial primary key,
  procedure_code text not null references procedures(code) on delete cascade,
  rule_json jsonb not null,
  created_at timestamptz not null default now()
);

create unique index if not exists rules_procedure_code_idx on rules(procedure_code);

-- Query logging for traceability
create table if not exists query_logs (
  id bigserial primary key,
  scenario_json jsonb not null,
  outcome text,
  created_at timestamptz not null default now()
);

-- Simple helper for vector similarity search
create or replace function match_insurance_chunks(
  query_embedding vector(1536),
  match_count integer default 3
)
returns table (
  id bigint,
  doc_id bigint,
  chunk_index integer,
  content text,
  similarity double precision
)
language sql
stable
as $$
  select
    ic.id,
    ic.doc_id,
    ic.chunk_index,
    ic.content,
    1 - (ic.embedding <=> query_embedding) as similarity
  from insurance_chunks ic
  order by ic.embedding <-> query_embedding
  limit greatest(match_count, 1);
$$;
