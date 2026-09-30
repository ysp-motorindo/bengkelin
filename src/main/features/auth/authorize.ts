import { DomainError } from '@/shared/primitives';
import type { Session } from './sessions';

/**
 * Service-level authorization. Every service method that is not public takes
 * `session: Session | undefined` (resolved by the IPC layer from the sender)
 * and starts with one of these. Hiding buttons is never the control.
 */
export function requireSession(session: Session | undefined): Session {
  if (!session) throw new DomainError('UNAUTHENTICATED', 'Sign in required');
  return session;
}

export function requireAdmin(session: Session | undefined): Session {
  const current = requireSession(session);
  if (current.role !== 'ADMIN') {
    throw new DomainError('FORBIDDEN', 'Administrator role required');
  }
  return current;
}
