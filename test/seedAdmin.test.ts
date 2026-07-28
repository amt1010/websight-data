import { describe, it, expect } from 'vitest';
import { parseSeedAdminArgs } from '../src/seedAdmin.js';

describe('parseSeedAdminArgs', () => {
  it('parses an email argument', () => {
    expect(parseSeedAdminArgs(['a@example.com'])).toEqual({ email: 'a@example.com' });
  });

  it('throws a usage error with no argument', () => {
    expect(() => parseSeedAdminArgs([])).toThrow(/Usage: seed:admin <email>/);
  });
});
