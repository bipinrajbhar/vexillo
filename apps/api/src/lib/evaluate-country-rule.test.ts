import { describe, it, expect } from 'bun:test';
import { evaluateCountryRule } from './evaluate-country-rule';

describe('evaluateCountryRule', () => {
  describe('no geo rules (allowedCountries empty)', () => {
    it('returns true when env toggle is ON', () => {
      expect(evaluateCountryRule({ allowedCountries: [], countryCode: 'US', envEnabled: true })).toBe(true);
    });

    it('returns false when env toggle is OFF', () => {
      expect(evaluateCountryRule({ allowedCountries: [], countryCode: 'US', envEnabled: false })).toBe(false);
    });

    it('returns envEnabled even when countryCode is null', () => {
      expect(evaluateCountryRule({ allowedCountries: [], countryCode: null, envEnabled: true })).toBe(true);
      expect(evaluateCountryRule({ allowedCountries: [], countryCode: null, envEnabled: false })).toBe(false);
    });
  });

  describe('geo rules configured (allowedCountries non-empty)', () => {
    it('returns envEnabled when countryCode is in the allowlist', () => {
      expect(evaluateCountryRule({ allowedCountries: ['US', 'CA', 'GB'], countryCode: 'CA', envEnabled: true })).toBe(true);
      expect(evaluateCountryRule({ allowedCountries: ['US', 'CA', 'GB'], countryCode: 'CA', envEnabled: false })).toBe(false);
    });

    it('returns false when countryCode is not in the allowlist', () => {
      expect(evaluateCountryRule({ allowedCountries: ['US', 'CA'], countryCode: 'DE', envEnabled: true })).toBe(false);
    });

    it('falls back to envEnabled when countryCode is null (no CloudFront header)', () => {
      expect(evaluateCountryRule({ allowedCountries: ['US'], countryCode: null, envEnabled: true })).toBe(true);
      expect(evaluateCountryRule({ allowedCountries: ['US'], countryCode: null, envEnabled: false })).toBe(false);
    });

    it('compares country codes case-insensitively', () => {
      expect(evaluateCountryRule({ allowedCountries: ['us', 'CA'], countryCode: 'US', envEnabled: true })).toBe(true);
      expect(evaluateCountryRule({ allowedCountries: ['US'], countryCode: 'us', envEnabled: true })).toBe(true);
    });

    it('returns false for non-whitelisted country regardless of env toggle', () => {
      expect(evaluateCountryRule({ allowedCountries: ['US'], countryCode: 'FR', envEnabled: true })).toBe(false);
    });
  });
});
