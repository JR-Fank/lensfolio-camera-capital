// Native Next.js does not expose Cloudflare bindings. Legacy route handlers stay
// frozen until their reads are replaced by Supabase in the next migration phase.
export const env = Object.freeze({ MIGRATION_READ_ONLY: "true" });
