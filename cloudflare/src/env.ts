export interface WorkerEnv {
  DB: D1Database;
  ALLOWED_ORIGINS?: string;
  TURNSTILE_SECRET_KEY?: string;
  RATE_LIMIT_SECRET?: string;
}
