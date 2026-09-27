/**
 * Every business error carries a stable `code` (e.g. `journal.unbalanced`).
 * The web app translates codes into English/Arabic, so messages here are only
 * a developer-facing fallback.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const fail = (code: string, message: string, details?: Record<string, unknown>): never => {
  throw new AppError(code, message, 400, details);
};

export const notFound = (entity: string, id?: number | string): never => {
  throw new AppError('not_found', `${entity} ${id ?? ''} not found`.trim(), 404, { entity, id });
};

export const conflict = (code: string, message: string, details?: Record<string, unknown>): never => {
  throw new AppError(code, message, 409, details);
};

export const unauthorized = (): never => {
  throw new AppError('auth.required', 'Login required', 401);
};

export const forbidden = (permission?: string): never => {
  throw new AppError('auth.forbidden', 'You do not have permission for this action', 403, { permission });
};

/** Reference data readable by any signed-in user — but only while its app is switched on. */
export const assertApp = (apps: { isEnabled(id: string): boolean }, id: string): void => {
  if (!apps.isEnabled(id)) throw new AppError('auth.forbidden', `The ${id} app is switched off`, 403, { app: id });
};
