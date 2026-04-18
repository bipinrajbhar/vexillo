/**
 * Evaluates whether a flag should be enabled for a given country.
 *
 * - allowedCountries empty → env toggle wins (no geo rules configured)
 * - countryCode null (CloudFront header absent) → env toggle wins
 * - countryCode in allowedCountries (case-insensitive) → true
 * - countryCode not in allowedCountries → false
 */
export function evaluateCountryRule({
  allowedCountries,
  countryCode,
  envEnabled,
}: {
  allowedCountries: string[];
  countryCode: string | null;
  envEnabled: boolean;
}): boolean {
  if (allowedCountries.length === 0) return envEnabled;
  if (countryCode === null) return envEnabled;
  const code = countryCode.toUpperCase();
  return allowedCountries.some((c) => c.toUpperCase() === code);
}
