export type DatabaseErrorCode =
  | 'FOREIGN_DATABASE'
  | 'UNSUPPORTED_SCHEMA'
  | 'MIGRATION_FAILED'
  | 'ASYNC_TRANSACTION'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'NOT_IN_TRANSACTION';

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  constructor(
    code: DatabaseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DatabaseError';
    this.code = code;
  }
}
