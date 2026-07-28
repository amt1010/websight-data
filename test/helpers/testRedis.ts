import { Redis } from 'ioredis';

export function createTestConnection(): Redis {
  const url = process.env.TEST_REDIS_URL;
  if (!url) {
    throw new Error('TEST_REDIS_URL must be set to run queue tests against a real Upstash test database');
  }
  return new Redis(url, { maxRetriesPerRequest: null });
}
