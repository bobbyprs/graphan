import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Wraps async route handlers so rejected promises reach the error middleware. */
export const asyncHandler =
  <R extends Request = Request>(fn: (req: R, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req as R, res, next).catch(next);
  };

export function parsePagination(q: Record<string, unknown>, defaults = { limit: 50, max: 500 }) {
  const limit = Math.min(Math.max(Number(q.limit) || defaults.limit, 1), defaults.max);
  const offset = Math.max(Number(q.offset) || 0, 0);
  return { limit, offset };
}

/** Parses durations like "30s", "5m", "1h", "1d" into milliseconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d|w)$/.exec(input.trim());
  if (!m) throw new Error(`Invalid duration: ${input}`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2] as 'ms'];
  return n * unit;
}
