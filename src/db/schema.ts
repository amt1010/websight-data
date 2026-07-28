import { pgTable, serial, text, timestamp, integer, jsonb } from 'drizzle-orm/pg-core';

export const crawls = pgTable('crawls', {
  id: serial('id').primaryKey(),
  domain: text('domain').notNull(),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
    .notNull()
    .default('queued'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
});

export const pages = pgTable('pages', {
  id: serial('id').primaryKey(),
  crawlId: integer('crawl_id')
    .notNull()
    .references(() => crawls.id),
  url: text('url').notNull(),
  path: text('path').notNull(),
  depth: integer('depth').notNull(),
  status: text('status', { enum: ['ok', 'error'] }).notNull(),
  error: text('error'),
  links: jsonb('links').notNull().$type<string[]>(),
  requestUrls: jsonb('request_urls').notNull().$type<string[]>(),
  scriptSrcs: jsonb('script_srcs').notNull().$type<string[]>(),
  domFingerprint: jsonb('dom_fingerprint').notNull().$type<Record<string, number>>(),
  screenshotKey: text('screenshot_key'),
  htmlKey: text('html_key'),
});

export const clusters = pgTable('clusters', {
  id: serial('id').primaryKey(),
  crawlId: integer('crawl_id')
    .notNull()
    .references(() => crawls.id),
  urlPattern: text('url_pattern').notNull(),
  pageUrls: jsonb('page_urls').notNull().$type<string[]>(),
  representativeFingerprint: jsonb('representative_fingerprint').notNull().$type<Record<string, number>>(),
});

export const integrations = pgTable('integrations', {
  id: serial('id').primaryKey(),
  crawlId: integer('crawl_id')
    .notNull()
    .references(() => crawls.id),
  name: text('name').notNull(),
  category: text('category').notNull(),
  matchedUrls: jsonb('matched_urls').notNull().$type<string[]>(),
});

export const plans = pgTable('plans', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  tier: text('tier', { enum: ['free', 'paid'] }).notNull(),
  scanLimit: integer('scan_limit').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull(),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  planId: integer('plan_id')
    .notNull()
    .references(() => plans.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scanUsage = pgTable('scan_usage', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  guestToken: text('guest_token'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
});
