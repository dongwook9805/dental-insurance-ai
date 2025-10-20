-- Reset tables for deterministic seeds
truncate table query_logs restart identity cascade;
truncate table rules restart identity cascade;
truncate table procedures restart identity cascade;

-- Load policy corpus (requires psql or Supabase CLI)

-- Procedure catalog
insert into procedures (code, description)
values
  ('CRN_POST_MOLAR', '하악 대구치 도재 크라운');

-- Rules
insert into rules (procedure_code, rule_json)
values (
  'CRN_POST_MOLAR',
  jsonb_build_object(
    'frequency', jsonb_build_object(
      'window_days', 540,
      'scope', 'same_tooth_same_surface'
    ),
    'age_min', 12,
    'same_visit_same_region', 'deny',
    'allow_exceptions', jsonb_build_array('fracture', 'secondary_caries'),
    'docs_required', jsonb_build_array('파절 사진', '방사선 사진')
  )
);
