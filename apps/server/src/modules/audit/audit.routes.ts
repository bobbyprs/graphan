import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { Permissions } from '../../lib/rbac';
import { asyncHandler, parsePagination } from '../../lib/http';
import { listAudit } from './audit.service';

const querySchema = z.object({
  action: z.string().optional(),
  userId: z.string().uuid().optional(),
  entityType: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

export const auditRouter = Router();

auditRouter.get(
  '/',
  requirePermission(Permissions.AUDIT_READ),
  validate(querySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof querySchema>;
    res.json(await listAudit(req.workspace!.id, q, parsePagination(q)));
  }),
);
