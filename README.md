# Dental Insurance AI – Deployment Notes

## Dataset & Seeding

1. Extract the PDF into vectorized chunks (requires `OPENAI_API_KEY` so embeddings match runtime queries):
   ```bash
   export OPENAI_API_KEY=sk-...
   python3 scripts/build_dataset.py \
     --pdf 2014.pdf \
     --title "2014년 치과 보험 청구 지침" \
     --source "2014.pdf" \
     --output supabase/seed/2014_chunks.sql \
     --max-chunks 200
   ```
2. Apply schema and seed data (requires `psql` or the Supabase SQL editor):
   ```bash
   psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_init.sql
   psql "$SUPABASE_DB_URL" -f supabase/seed/2014_chunks.sql
   psql "$SUPABASE_DB_URL" -f supabase/seed/seed.sql
   ```
The dataset script now generates 1536-dimension OpenAI embeddings (model `text-embedding-3-small`) so runtime queries search the same vector space.

## Edge Functions

Deploy both functions after updating environment secrets (`OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`):

```bash
supabase functions deploy claim-plan
supabase functions deploy rag-answer
```

## Frontend Usage

- Copy `docs/config.sample.js` to `docs/config.js` and set `edgeBase` plus any required headers (e.g. Supabase anon key).
- Launch locally with `npx serve docs` or publish via GitHub Pages (`main` branch, `/docs` folder).
- The web UI exposes two modes: 자유 입력(텍스트)와 간편 양식(필드 기반). The form preview panel shows the JSON payload that will be sent to the Edge Functions.

## Keeping Code Private

GitHub Pages serves repository files as-is. To avoid exposing backend code:

1. Keep this repo private (GitHub paid plans).
2. Or publish a secondary public repo containing only the `docs/` directory.
3. Or host the static assets elsewhere.

Edge Functions and database credentials remain outside the static bundle; only `docs/` is published.
