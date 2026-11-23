import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedSlackWebhook, isAllowedTeamsWebhook, isPublicHttpsUrlSyntax } from './notifiers';

test('slack webhook allowlist: accepts only https hooks.slack.com', () => {
  assert.equal(isAllowedSlackWebhook('https://hooks.slack.com/services/T000/B000/XXXX'), true);
  assert.equal(isAllowedSlackWebhook('http://hooks.slack.com/services/x'), false); // not https
  assert.equal(isAllowedSlackWebhook('https://hooks.slack.com.evil.com/x'), false); // suffix spoof
  assert.equal(isAllowedSlackWebhook('https://example.com/x'), false);
  assert.equal(isAllowedSlackWebhook('not a url'), false);
});

test('teams webhook allowlist still restricts to Microsoft hosts', () => {
  assert.equal(isAllowedTeamsWebhook('https://acme.webhook.office.com/webhookb2/abc'), true);
  assert.equal(isAllowedTeamsWebhook('https://hooks.slack.com/services/x'), false);
});

test('generic webhook syntax guard: requires public https endpoints', () => {
  assert.equal(isPublicHttpsUrlSyntax('https://alerts.example.com/hook'), true);
  assert.equal(isPublicHttpsUrlSyntax('http://alerts.example.com/hook'), false); // not https
  assert.equal(isPublicHttpsUrlSyntax('https://user:pass@example.com/hook'), false); // embedded creds
});

test('generic webhook syntax guard: blocks internal / SSRF targets', () => {
  for (const url of [
    'https://localhost/hook',
    'https://service.local/hook',
    'https://api.internal/hook',
    'https://127.0.0.1/hook',
    'https://10.0.0.5/hook',
    'https://192.168.1.10/hook',
    'https://172.16.4.4/hook',
    'https://169.254.169.254/latest/meta-data', // cloud metadata
    'https://[::1]/hook',
  ]) {
    assert.equal(isPublicHttpsUrlSyntax(url), false, url);
  }
});
