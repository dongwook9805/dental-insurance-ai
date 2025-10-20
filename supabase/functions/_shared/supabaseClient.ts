import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getEnv } from "./env.ts";

type Database = Record<string, never>;

let cachedClient: SupabaseClient<Database> | null = null;

export function getServiceSupabaseClient(): SupabaseClient<Database> {
  if (cachedClient) {
    return cachedClient;
  }
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  cachedClient = createClient<Database>(url, key, {
    auth: { persistSession: false },
    global: { headers: { "x-client-info": "dental-insurance-ai/edge" } },
  });
  return cachedClient;
}
