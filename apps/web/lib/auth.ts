import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, okta } from 'better-auth/plugins/generic-oauth';
import { nextCookies } from 'better-auth/next-js';
import { db } from './db';
import { authUser, authSession, authAccount, authVerification } from './schema';

export const auth = betterAuth({
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
    nextCookies(),
  ],
  session: {
    expiresIn: 60 * 60 * 24 * 7,  // 7 days
    updateAge: 60 * 60 * 24,       // refresh session if older than 1 day
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
          const [existing] = await db.select({ id: authUser.id }).from(authUser).limit(1);
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
