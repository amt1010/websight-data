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
