import { db } from "@/lib/db";
import { environments, apiKeys } from "@/lib/schema";
import { eq, asc } from "drizzle-orm";

export type DashboardEnvironmentRow = {
  id: string;
  name: string;
  slug: string;
  allowedOrigins: string[];
  createdAt: Date;
  keyHint: string | null;
};

export async function getDashboardEnvironmentsList() {
  return db
    .select({
      id: environments.id,
      name: environments.name,
      slug: environments.slug,
      allowedOrigins: environments.allowedOrigins,
      createdAt: environments.createdAt,
      keyHint: apiKeys.keyHint,
    })
    .from(environments)
    .leftJoin(apiKeys, eq(apiKeys.environmentId, environments.id))
    .orderBy(asc(environments.name));
}
