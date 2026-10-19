// NZ phone number handling. Everything is stored and compared as E.164 (+6421...).
// Uses the "max" metadata so we can tell mobiles from landlines (texts only go to mobiles).

import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/** '021 123 4567', '+64 21 123 4567', '6421...' → '+64211234567'. Null if not a valid number. */
export function toE164(input: string | null | undefined, defaultCountry: 'NZ' | 'AU' = 'NZ'): string | null {
  if (!input) return null;
  const parsed = parsePhoneNumberFromString(String(input), defaultCountry);
  return parsed?.isValid() ? parsed.number : null;
}

export function isMobile(e164: string): boolean {
  const type = parsePhoneNumberFromString(e164)?.getType();
  return type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE';
}

/** '+6495551234' → '09 555 1234' for reading out or printing in texts. */
export function formatNational(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatNational() ?? e164;
}
