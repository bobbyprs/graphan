import { lookup } from 'node:dns/promises';
import net from 'node:net';
import nodemailer, { type Transporter } from 'nodemailer';
import type { NotificationChannel } from '@prisma/client';
import { env } from '../../config/env';
import { decrypt } from '../../lib/crypto';
import { logger } from '../../lib/logger';

export interface AlertNotification {
  ruleId: string;
  ruleName: string;
  state: 'FIRING' | 'OK' | 'NO_DATA' | 'ERROR';
  severity: string;
  value: number | null;
  message: string;
  workspaceName: string;
}

/** Teams webhook URLs are restricted to Microsoft endpoints to prevent SSRF. */
const TEAMS_HOSTS = [/\.webhook\.office\.com$/i, /\.logic\.azure\.com$/i, /\.powerplatform\.com$/i, /\.environment\.api\.powerplatform\.com$/i];

export function isAllowedTeamsWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && TEAMS_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

/** Slack incoming-webhook URLs live on hooks.slack.com only. */
export function isAllowedSlackWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 'hooks.slack.com';
  } catch {
    return false;
  }
}

// ───────────────────── Generic webhook SSRF protection ─────────────────────

function isPrivateIp(ip: string): boolean {
  const addr = ip.split('%')[0]; // strip IPv6 zone id
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(addr)) {
    const l = addr.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7)); // IPv4-mapped
    if (l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true; // link-local, ULA
    return false;
  }
  return true; // not a valid IP → treat as unsafe
}

/** Cheap, synchronous sanity check used for early validation (no DNS). */
export function isPublicHttpsUrlSyntax(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (net.isIP(host) && isPrivateIp(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Full guard applied just before delivery: rejects https-less URLs, embedded
 * credentials, and hosts that resolve to private/reserved addresses. A small
 * TOCTOU window remains (DNS could change between lookup and fetch); `redirect:
 * 'error'` on the request blocks redirect-based pivots. Channels are admin-only.
 */
async function assertPublicWebhookUrl(raw: string): Promise<void> {
  if (!isPublicHttpsUrlSyntax(raw)) throw new Error('Webhook URL must be a public https endpoint');
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Webhook host is a private address');
    return;
  }
  const resolved = await lookup(host, { all: true }).catch(() => []);
  if (!resolved.length) throw new Error('Webhook host did not resolve');
  for (const r of resolved) if (isPrivateIp(r.address)) throw new Error('Webhook host resolves to a private address');
}

async function postJson(url: string, body: unknown, label: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`${label} webhook returned ${res.status}`);
}

let transporter: Transporter | undefined;
function mailer(): Transporter {
  if (!env.SMTP_HOST) throw new Error('SMTP is not configured (SMTP_HOST)');
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  return transporter;
}

/** Generic e-mail sender (report subscriptions). */
export async function sendMail(opts: Parameters<Transporter['sendMail']>[0]) {
  return mailer().sendMail({ from: env.SMTP_FROM, ...opts });
}
export const smtpConfigured = () => !!env.SMTP_HOST;

const STATE_COLOR: Record<AlertNotification['state'], string> = { FIRING: '#E02F44', OK: '#56A64B', NO_DATA: '#8E8E8E', ERROR: '#FF9830' };

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function sendEmail(recipients: string[], n: AlertNotification) {
  const link = `${env.APP_PUBLIC_URL}/alerts/${n.ruleId}`;
  const subject = `[${n.state}] ${n.ruleName} (${n.severity})`;
  await mailer().sendMail({
    from: env.SMTP_FROM,
    to: recipients.join(','),
    subject,
    text: `${subject}\n\n${n.message}\nValue: ${n.value ?? 'n/a'}\nWorkspace: ${n.workspaceName}\n\n${link}`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif">
      <h2 style="color:${STATE_COLOR[n.state]};margin:0 0 8px">${escapeHtml(subject)}</h2>
      <p>${escapeHtml(n.message)}</p>
      <table cellpadding="4"><tr><td><b>Value</b></td><td>${n.value ?? 'n/a'}</td></tr>
      <tr><td><b>Workspace</b></td><td>${escapeHtml(n.workspaceName)}</td></tr></table>
      <p><a href="${escapeHtml(link)}">Open in Graphan</a></p></div>`,
  });
}

async function sendTeams(webhookUrl: string, n: AlertNotification) {
  if (!isAllowedTeamsWebhook(webhookUrl)) throw new Error('Webhook URL is not an allowed Microsoft Teams endpoint');
  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', size: 'Large', weight: 'Bolder', text: `${n.state === 'FIRING' ? '🔴' : n.state === 'OK' ? '✅' : '⚠️'} ${n.ruleName}`, wrap: true },
            { type: 'TextBlock', text: n.message, wrap: true },
            {
              type: 'FactSet',
              facts: [
                { title: 'State', value: n.state },
                { title: 'Severity', value: n.severity },
                { title: 'Value', value: String(n.value ?? 'n/a') },
                { title: 'Workspace', value: n.workspaceName },
              ],
            },
          ],
          actions: [{ type: 'Action.OpenUrl', title: 'Open in Graphan', url: `${env.APP_PUBLIC_URL}/alerts/${n.ruleId}` }],
        },
      },
    ],
  };
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`Teams webhook returned ${res.status}`);
}

async function sendSlack(webhookUrl: string, n: AlertNotification) {
  if (!isAllowedSlackWebhook(webhookUrl)) throw new Error('Webhook URL is not an allowed Slack endpoint (hooks.slack.com)');
  const emoji = n.state === 'FIRING' ? ':red_circle:' : n.state === 'OK' ? ':white_check_mark:' : ':warning:';
  const payload = {
    text: `${emoji} [${n.state}] ${n.ruleName} (${n.severity})`,
    attachments: [
      {
        color: STATE_COLOR[n.state],
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${n.ruleName}*\n${n.message}` } },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*State:*\n${n.state}` },
              { type: 'mrkdwn', text: `*Severity:*\n${n.severity}` },
              { type: 'mrkdwn', text: `*Value:*\n${n.value ?? 'n/a'}` },
              { type: 'mrkdwn', text: `*Workspace:*\n${n.workspaceName || 'n/a'}` },
            ],
          },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Graphan' }, url: `${env.APP_PUBLIC_URL}/alerts/${n.ruleId}` }] },
        ],
      },
    ],
  };
  await postJson(webhookUrl, payload, 'Slack');
}

/** Generic webhook: posts a stable JSON envelope to any public https endpoint. */
async function sendWebhook(webhookUrl: string, n: AlertNotification) {
  await assertPublicWebhookUrl(webhookUrl);
  const payload = {
    ruleId: n.ruleId,
    rule: n.ruleName,
    state: n.state,
    severity: n.severity,
    value: n.value,
    message: n.message,
    workspace: n.workspaceName,
    url: `${env.APP_PUBLIC_URL}/alerts/${n.ruleId}`,
    timestamp: new Date().toISOString(),
  };
  await postJson(webhookUrl, payload, 'Webhook');
}

export async function notifyChannel(channel: NotificationChannel, n: AlertNotification) {
  const cfg = channel.config as Record<string, unknown>;
  try {
    if (channel.type === 'EMAIL') await sendEmail((cfg.recipients as string[]) ?? [], n);
    else if (channel.type === 'TEAMS') await sendTeams(decrypt(String(cfg.webhookUrlEncrypted)), n);
    else if (channel.type === 'SLACK') await sendSlack(decrypt(String(cfg.webhookUrlEncrypted)), n);
    else if (channel.type === 'WEBHOOK') await sendWebhook(decrypt(String(cfg.webhookUrlEncrypted)), n);
  } catch (err) {
    logger.error({ err, channel: channel.id, rule: n.ruleId }, 'Notification delivery failed');
    throw err;
  }
}
