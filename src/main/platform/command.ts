import { z } from 'zod';
import { DomainError, type Result } from '@/shared/primitives';
import type { Logger } from './logger';

/** Who is calling: the renderer window (webContents id) behind the request. */
export interface CommandContext {
  windowId: number;
}

/** A named, schema-validated command. Electron-free so tests can drive it. */
export interface Command {
  channel: string;
  schema: z.ZodType;
  handler: (context: CommandContext, input: never) => unknown;
}

/**
 * Declares a command. The handler receives the PARSED input (unknown keys
 * rejected, transforms applied) and returns a plain value or throws a
 * `DomainError`; `executeCommand` turns either into a `Result`.
 */
export function command<S extends z.ZodType, T>(
  channel: string,
  schema: S,
  handler: (context: CommandContext, input: z.output<S>) => T | Promise<T>,
): Command {
  return { channel, schema, handler: handler as Command['handler'] };
}

function validationFailed(error: z.ZodError): Result<never> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : '_form';
    fieldErrors[field] ??= issue.message.startsWith('validation.')
      ? issue.message
      : 'validation.invalid';
  }
  return {
    ok: false,
    error: {
      code: 'VALIDATION_FAILED',
      messageKey: 'errors.VALIDATION_FAILED',
      fieldErrors,
    },
  };
}

/**
 * The single place where input validation and error mapping happen:
 * - invalid input -> `VALIDATION_FAILED` with `fieldErrors` (never a throw);
 * - `DomainError` -> `{ code, messageKey: 'errors.<CODE>' }`;
 * - anything else -> `INTERNAL_ERROR`, logged sanitized (no payload).
 */
export async function executeCommand(
  cmd: Command,
  context: CommandContext,
  raw: unknown,
  logger: Logger,
): Promise<Result<unknown>> {
  try {
    const parsed = cmd.schema.safeParse(raw);
    if (!parsed.success) return validationFailed(parsed.error);
    const value = await cmd.handler(context, parsed.data as never);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof DomainError) {
      logger.warn('command.rejected', {
        channel: cmd.channel,
        code: error.code,
      });
      return {
        ok: false,
        error: { code: error.code, messageKey: `errors.${error.code}` },
      };
    }
    logger.error('command.failed', { channel: cmd.channel, error });
    return {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        messageKey: 'errors.INTERNAL_ERROR',
      },
    };
  }
}
