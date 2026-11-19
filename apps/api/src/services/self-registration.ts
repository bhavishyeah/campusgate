/** ALLOW_SELF_REGISTRATION kill switch: default on; false/0/no (any case) turns it off. Read per request. */
export function isSelfRegistrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ALLOW_SELF_REGISTRATION;
  if (v === undefined) return true;
  return !["false", "0", "no"].includes(v.trim().toLowerCase());
}
