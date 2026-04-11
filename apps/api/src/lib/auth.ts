import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, okta } from 'better-auth/plugins/generic-oauth';
import { authUser, authSession, authAccount, authVerification } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';

export function createAuth(db: DbClient) {
  return betterAuth({
    baseURL: process.env.BETTER_AUTH_URL,
    trustedOrigins: process.env.BETTER_AUTH_TRUSTED_ORIGINS
      ? process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(',')
      : [],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
      },
    }),
    plugins: [
      genericOAuth({
        config: [
          okta({
            clientId: process.env.OKTA_CLIENT_ID!,
            clientSecret: process.env.OKTA_CLIENT_SECRET!,
            issuer: process.env.OKTA_ISSUER!,
          }),
        ],
      }),
    ],
    session: {
      expiresIn: 60 * 60 * 24 * 7,   // 7 days
      updateAge: 60 * 60 * 24,        // refresh if older than 1 day
    },
    user: {
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          defaultValue: 'viewer',
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const [existing] = await db
              .select({ id: authUser.id })
              .from(authUser)
              .limit(1);
            return {
              data: {
                ...user,
                role: existing ? 'viewer' : 'admin',
              },
            };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
