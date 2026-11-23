import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'CREDENTIALS_ENCRYPTION_KEY must be 32 bytes base64'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  QUERY_MAX_ROWS: z.coerce.number().int().positive().default(10_000),
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('Graphan Alerts <alerts@example.com>'),
  APP_PUBLIC_URL: z.string().default('http://localhost:5173'),
  /** SQLite data sources may only open files inside this directory (prevents arbitrary file reads). */
  SQLITE_BASE_DIR: z.string().default('./data'),
  /**
   * Shared secret your other applications use to sign embed tokens (HS256).
   * Unset = embedding disabled. Generate: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   */
  EMBED_SECRET: z.string().min(32, 'EMBED_SECRET must be at least 32 chars').optional().or(z.literal('').transform(() => undefined)),
  /** How long an embedded dashboard stays usable after it is opened */
  EMBED_SESSION_TTL: z.string().default('8h'),
  /** Disable background jobs on API-only replicas */
  ENABLE_SCHEDULER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
