/* eslint-disable no-console */
import { PrismaClient, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

/**
 * Seeds: super admin, "Default" workspace, demo users per role, sample data source
 * (the `sample-db` Postgres from docker-compose) and the sample dashboards.
 *
 * Self-contained on purpose (no imports from src/) so it runs before env validation.
 */
const prisma = new PrismaClient();

function encryptJson(obj: unknown): string {
  const key = Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes base64');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

async function main() {
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@graphan.local').toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345';

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: { email: adminEmail, name: 'Administrator', isSuperAdmin: true, passwordHash: await bcrypt.hash(adminPassword, 12) },
  });

  const ws = await prisma.workspace.upsert({
    where: { slug: 'default' },
    update: {},
    create: { name: 'Default', slug: 'default', description: 'Default workspace' },
  });
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: ws.id, userId: admin.id } },
    update: { role: 'ADMIN' },
    create: { workspaceId: ws.id, userId: admin.id, role: 'ADMIN' },
  });

  // Demo users, one per role (password: Demo@123456)
  const demoHash = await bcrypt.hash('Demo@123456', 12);
  for (const role of ['DEVELOPER', 'ANALYST', 'VIEWER'] as const) {
    const u = await prisma.user.upsert({
      where: { email: `${role.toLowerCase()}@graphan.local` },
      update: {},
      create: { email: `${role.toLowerCase()}@graphan.local`, name: `Demo ${role[0]}${role.slice(1).toLowerCase()}`, passwordHash: demoHash },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: ws.id, userId: u.id } },
      update: { role },
      create: { workspaceId: ws.id, userId: u.id, role },
    });
  }

  const team = await prisma.team.upsert({
    where: { workspaceId_name: { workspaceId: ws.id, name: 'Analytics' } },
    update: {},
    create: { workspaceId: ws.id, name: 'Analytics', description: 'Business analytics team' },
  });
  const analyst = await prisma.user.findUniqueOrThrow({ where: { email: 'analyst@graphan.local' } });
  await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: team.id, userId: analyst.id } },
    update: {},
    create: { teamId: team.id, userId: analyst.id },
  });

  // Sample data source
  const ds = await prisma.dataSource.upsert({
    where: { workspaceId_name: { workspaceId: ws.id, name: 'Sample Sales DB' } },
    update: {},
    create: {
      workspaceId: ws.id,
      name: 'Sample Sales DB',
      type: 'POSTGRES',
      host: process.env.SAMPLE_DB_HOST ?? 'localhost',
      port: Number(process.env.SAMPLE_DB_PORT ?? 5433),
      database: process.env.SAMPLE_DB_NAME ?? 'sample',
      username: process.env.SAMPLE_DB_USER ?? 'sample_reader',
      encryptedSecrets: encryptJson({ password: process.env.SAMPLE_DB_PASSWORD ?? 'sample_reader' }),
      readOnly: true,
      options: { poolMax: 5, defaultSchema: 'public' },
      createdById: admin.id,
    },
  });

  // Sample dashboards from the built-in templates
  const { BUILTIN_TEMPLATES, instantiateTemplate } = await import('../src/modules/dashboards/templates');
  for (const tpl of BUILTIN_TEMPLATES.filter((t) => t.id !== 'blank')) {
    const exists = await prisma.dashboard.findFirst({ where: { workspaceId: ws.id, title: tpl.title } });
    if (exists) continue;
    const definition = instantiateTemplate(tpl.definition, ds.id) as unknown as Prisma.InputJsonValue;
    const d = await prisma.dashboard.create({
      data: {
        workspaceId: ws.id,
        ownerId: admin.id,
        title: tpl.title,
        description: tpl.description,
        tags: tpl.tags,
        refreshInterval: tpl.refreshInterval,
        definition,
      },
    });
    await prisma.dashboardVersion.create({ data: { dashboardId: d.id, version: 1, definition, createdById: admin.id, message: 'Seeded' } });
  }

  // Sample alert
  const existingRule = await prisma.alertRule.findFirst({ where: { workspaceId: ws.id, name: 'High average CPU' } });
  if (!existingRule) {
    await prisma.alertRule.create({
      data: {
        workspaceId: ws.id,
        dataSourceId: ds.id,
        name: 'High average CPU',
        description: 'Average CPU across hosts over the last 15 minutes',
        query: 'SELECT AVG(cpu) AS value FROM server_metrics WHERE ts BETWEEN $__timeFrom AND $__timeTo',
        condition: { field: 'value', reducer: 'last', operator: 'gt', threshold: 80, lookback: 'now-15m', noDataState: 'NO_DATA' },
        intervalSeconds: 60,
        forSeconds: 300,
        severity: 'critical',
        createdById: admin.id,
      },
    });
  }

  console.log(`✅ Seed complete. Login: ${adminEmail} / ${adminPassword}  (demo users: developer|analyst|viewer@graphan.local / Demo@123456)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
