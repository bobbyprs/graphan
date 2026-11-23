import type { Role } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; name: string; isSuperAdmin: boolean };
      workspace?: { id: string; role: Role };
    }
  }
}

export {};
