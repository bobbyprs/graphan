-- Add Slack and generic Webhook notification channel types.
-- PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as long as
-- the new value is not used in the same transaction (it isn't here).
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'SLACK';
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'WEBHOOK';
