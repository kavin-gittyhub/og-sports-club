export class HttpError extends Error {
  constructor(status, message, code = undefined, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, code = 'BAD_REQUEST', details) => new HttpError(400, msg, code, details);
export const unauthorized = (msg = 'Please sign in to continue.') => new HttpError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (msg = 'Not found.') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg, code = 'CONFLICT', details) => new HttpError(409, msg, code, details);

/** Postgres exclusion-constraint violation → friendly 409. */
export function isOverlapViolation(err) {
  return err && (err.code === '23P01' || /no_overlap/.test(err.constraint || ''));
}
