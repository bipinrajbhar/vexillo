// Schema is now defined in @vexillo/db. Re-export everything so existing
// imports inside apps/web continue to work without changes.
export {
  authUser,
  authSession,
  authAccount,
  authVerification,
  environments,
  flags,
  flagStates,
  apiKeys,
} from '@vexillo/db';
