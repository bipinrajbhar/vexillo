-- Multi-tenancy: Phase B — add org_id to flags and environments
--
-- Scopes environments and flags to an organisation.  Composite unique
-- constraints replace the previous global-unique ones so that each org can
-- freely use slugs/keys like "production" or "new-checkout" without conflicts.
--
-- Greenfield deployment: no existing data migration required.

--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "environments" DROP CONSTRAINT "environments_slug_unique";
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_org_id_slug_unique" UNIQUE("org_id", "slug");
--> statement-breakpoint
ALTER TABLE "flags" ADD COLUMN "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "flags" DROP CONSTRAINT "flags_key_unique";
--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_org_id_key_unique" UNIQUE("org_id", "key");
