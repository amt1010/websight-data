import { describe, it, expect, vi } from 'vitest';

const workerCtor = vi.fn();

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(...args: unknown[]) {
      workerCtor(...args);
    }
  },
}));

const { createCrawlWorker } = await import('../../src/queue/worker.js');

describe('createCrawlWorker', () => {
  it('configures a lock duration long enough to survive a real multi-page crawl', () => {
    createCrawlWorker({} as never, {} as never, {} as never);

    const [, , options] = workerCtor.mock.calls[0];
    // BullMQ's default lockDuration (30s) is far shorter than a real crawl,
    // which causes lock-renewal failures, stalled-job reassignment, and a
    // "browserContext.close: Target page, context or browser has been
    // closed" race between the original and reassigned attempts.
    expect(options.lockDuration).toBeGreaterThanOrEqual(600_000);
  });
});
