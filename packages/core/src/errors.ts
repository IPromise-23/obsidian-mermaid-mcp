import type { StructuredError } from './types.js';

export class CoreError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.details = details;
  }
}

export function asStructuredError(error: unknown, fallbackCode = 'INTERNAL_ERROR'): StructuredError {
  if (error instanceof CoreError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: fallbackCode, message: error.message };
  }
  return { code: fallbackCode, message: String(error) };
}

export function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new CoreError(code, message, details);
}
