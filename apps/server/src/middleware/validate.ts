import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { BadRequest } from '../lib/errors';

type Source = 'body' | 'query' | 'params';

/** Validates & coerces a request part with zod; replaces it with the parsed value. */
export const validate =
  (schema: ZodTypeAny, source: Source = 'body') =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return next(BadRequest('Validation failed', result.error.flatten()));
    if (source === 'query') {
      // req.query is a getter in Express 5; assign in place for forward compatibility.
      Object.assign(req.query, result.data);
    } else {
      (req as unknown as Record<Source, unknown>)[source] = result.data;
    }
    next();
  };

export type Body<S extends ZodTypeAny> = z.infer<S>;
