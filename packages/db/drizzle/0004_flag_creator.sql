ALTER TABLE "flags" ADD COLUMN "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL;
