import { describe, it, expect } from 'vitest';
import { parseCliCommand } from '../src/cli.js';

describe('parseCliCommand', () => {
  it('parses an enqueue command', () => {
    expect(parseCliCommand(['enqueue', 'example.com'])).toEqual({ command: 'enqueue', domain: 'example.com' });
  });

  it('parses a status command', () => {
    expect(parseCliCommand(['status', '42'])).toEqual({ command: 'status', crawlId: 42 });
  });

  it('throws on an unknown command', () => {
    expect(() => parseCliCommand(['bogus'])).toThrow();
  });

  it('throws when enqueue is missing a domain', () => {
    expect(() => parseCliCommand(['enqueue'])).toThrow();
  });

  it('throws when status is given a non-numeric id', () => {
    expect(() => parseCliCommand(['status', 'abc'])).toThrow();
  });
});
