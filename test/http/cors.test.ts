import { describe, it, expect, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../../src/http/cors.js';

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    status: vi.fn(function (this: unknown) {
      return this;
    }),
    end: vi.fn(),
    headers,
  };
  return res as unknown as VercelResponse & { headers: Record<string, string> };
}

describe('applyCors', () => {
  it('sets CORS headers on every request', () => {
    const req = { method: 'POST' } as VercelRequest;
    const res = fakeRes();

    applyCors(req, res);

    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('POST');
    expect(res.headers['Access-Control-Allow-Headers']).toContain('Authorization');
  });

  it('short-circuits OPTIONS preflight requests with 204 and returns true', () => {
    const req = { method: 'OPTIONS' } as VercelRequest;
    const res = fakeRes();

    const handled = applyCors(req, res);

    expect(handled).toBe(true);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it('returns false for non-OPTIONS requests so the handler continues', () => {
    const req = { method: 'GET' } as VercelRequest;
    const res = fakeRes();

    const handled = applyCors(req, res);

    expect(handled).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });
});
