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

export async function notifyChannel(channel: NotificationChannel, n: AlertNotification) {
  const cfg = channel.config as Record<string, unknown>;
  try {
    if (channel.type === 'EMAIL') await sendEmail((cfg.recipients as string[]) ?? [], n);
    else if (channel.type === 'TEAMS') await sendTeams(decrypt(String(cfg.webhookUrlEncrypted)), n);
  } catch (err) {
    logger.error({ err, channel: channel.id, rule: n.ruleId }, 'Notification delivery failed');
    throw err;
  }
}
