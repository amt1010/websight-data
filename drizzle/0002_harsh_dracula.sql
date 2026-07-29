ALTER TABLE "crawls" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "guest_token" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crawls" ADD CONSTRAINT "crawls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
