export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'ERROR',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const BadRequest = (msg = 'Bad request', details?: unknown) => new AppError(400, msg, 'BAD_REQUEST', details);
export const Unauthorized = (msg = 'Unauthorized') => new AppError(401, msg, 'UNAUTHORIZED');
export const Forbidden = (msg = 'Forbidden') => new AppError(403, msg, 'FORBIDDEN');
export const NotFound = (entity = 'Resource') => new AppError(404, `${entity} not found`, 'NOT_FOUND');
export const Conflict = (msg = 'Conflict') => new AppError(409, msg, 'CONFLICT');
