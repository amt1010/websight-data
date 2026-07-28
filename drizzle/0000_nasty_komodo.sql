CREATE TABLE IF NOT EXISTS "clusters" (
	"id" serial PRIMARY KEY NOT NULL,
	"crawl_id" integer NOT NULL,
	"url_pattern" text NOT NULL,
	"page_urls" jsonb NOT NULL,
	"representative_fingerprint" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crawls" (
	"id" serial PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"crawl_id" integer NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"matched_urls" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"crawl_id" integer NOT NULL,
	"url" text NOT NULL,
	"path" text NOT NULL,
	"depth" integer NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"links" jsonb NOT NULL,
	"request_urls" jsonb NOT NULL,
	"script_srcs" jsonb NOT NULL,
	"dom_fingerprint" jsonb NOT NULL,
	"screenshot_key" text,
	"html_key" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clusters" ADD CONSTRAINT "clusters_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integrations" ADD CONSTRAINT "integrations_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pages" ADD CONSTRAINT "pages_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
