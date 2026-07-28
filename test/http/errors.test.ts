import { describe, it, expect } from 'vitest';
import {
  BadRequestError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  QuotaExceededError,
  errorToResponse,
} from '../../src/http/errors.js';

describe('errorToResponse', () => {
  it('maps BadRequestError to 400', () => {
    expect(errorToResponse(new BadRequestError('bad'))).toEqual({ status: 400, body: { error: 'bad' } });
  });

  it('maps AuthError to 401', () => {
    expect(errorToResponse(new AuthError('nope'))).toEqual({ status: 401, body: { error: 'nope' } });
  });

  it('maps ForbiddenError to 403', () => {
    expect(errorToResponse(new ForbiddenError('nope'))).toEqual({ status: 403, body: { error: 'nope' } });
  });

  it('maps NotFoundError to 404', () => {
    expect(errorToResponse(new NotFoundError('missing'))).toEqual({ status: 404, body: { error: 'missing' } });
  });

  it('maps ConflictError to 409', () => {
    expect(errorToResponse(new ConflictError('conflict'))).toEqual({ status: 409, body: { error: 'conflict' } });
  });

  it('maps QuotaExceededError to 402 with details', () => {
    const err = new QuotaExceededError({ plan: 'Guest', scanLimit: 1, used: 1 });
    expect(errorToResponse(err)).toEqual({
      status: 402,
      body: { error: 'Scan quota exceeded', plan: 'Guest', scanLimit: 1, used: 1 },
    });
  });

  it('maps an unknown error to 500 without leaking its message', () => {
    expect(errorToResponse(new Error('secret internals'))).toEqual({
      status: 500,
      body: { error: 'Internal server error' },
    });
  });
});
