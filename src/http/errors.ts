export class AppError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
  }
}

export interface QuotaDetails {
  plan: string;
  scanLimit: number;
  used: number;
}

export class QuotaExceededError extends AppError {
  readonly details: QuotaDetails;
  constructor(details: QuotaDetails) {
    super('Scan quota exceeded', 402);
    this.details = details;
  }
}

export function errorToResponse(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof QuotaExceededError) {
    return { status: 402, body: { error: err.message, ...err.details } };
  }
  if (err instanceof AppError) {
    return { status: err.status, body: { error: err.message } };
  }
  return { status: 500, body: { error: 'Internal server error' } };
}
