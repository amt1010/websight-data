import { describe, it, expect } from 'vitest';
import { createInMemoryStorage } from '../../src/storage/index.js';

describe('createInMemoryStorage', () => {
  it('round-trips a put object through get', async () => {
    const storage = createInMemoryStorage();
    const body = Buffer.from('hello world');
    const key = await storage.put('a/b/c.txt', body, 'text/plain');
    expect(key).toBe('a/b/c.txt');
    const read = await storage.get('a/b/c.txt');
    expect(read).toEqual(body);
  });

  it('throws when getting a key that was never put', async () => {
    const storage = createInMemoryStorage();
    await expect(storage.get('missing')).rejects.toThrow();
  });
});
