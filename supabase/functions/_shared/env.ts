const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
] as const;

type RequiredEnv = (typeof requiredEnv)[number];

const cache = new Map<string, string>();

export function getEnv(name: RequiredEnv): string {
  if (cache.has(name)) {
    return cache.get(name)!;
  }
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  cache.set(name, value);
  return value;
}
