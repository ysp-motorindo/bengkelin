import { CHANNELS } from '@/shared/channels';
import {
  cashierIdInputSchema,
  changeRoleInputSchema,
  createCashierInputSchema,
  loginInputSchema,
  noInput,
  preferencesInputSchema,
  resetPasswordInputSchema,
  setupInputSchema,
  shopSettingsInputSchema,
  updateDisplayNameInputSchema,
} from '@/shared/contracts';
import { command, type Command } from './command';
import type { ApplicationServices } from './services';

/**
 * The application's whole command surface: channel + Zod schema + handler.
 * Handlers are one-liners that resolve the caller's session from the window
 * and delegate to a service; services enforce authorization and return DTOs.
 * Add a feature by appending its commands here (and its channels/bridge/preload).
 */
export function buildCommands(services: ApplicationServices): Command[] {
  const { auth, settings, cashiers, app, sessions } = services;
  const C = CHANNELS;
  const session = (windowId: number) => sessions.get(windowId);

  return [
    command(C.app.ping, noInput, () => 'pong'),
    command(C.app.openLogFolder, noInput, ({ windowId }) =>
      app.openLogFolder(session(windowId)),
    ),

    command(C.auth.login, loginInputSchema, ({ windowId }, input) =>
      auth.login(input, windowId),
    ),
    command(C.auth.logout, noInput, ({ windowId }) => auth.logout(windowId)),
    command(C.auth.currentSession, noInput, ({ windowId }) =>
      auth.currentSession(session(windowId)),
    ),

    command(C.settings.getPublic, noInput, () => settings.getPublic()),
    command(C.settings.completeSetup, setupInputSchema, (_ctx, input) =>
      settings.completeSetup(input),
    ),
    command(
      C.settings.updateShop,
      shopSettingsInputSchema,
      ({ windowId }, input) => settings.updateShop(session(windowId), input),
    ),
    command(
      C.settings.updatePreferences,
      preferencesInputSchema,
      ({ windowId }, input) =>
        settings.updatePreferences(session(windowId), input),
    ),

    command(C.cashiers.list, noInput, ({ windowId }) =>
      cashiers.list(session(windowId)),
    ),
    command(
      C.cashiers.create,
      createCashierInputSchema,
      ({ windowId }, input) => cashiers.create(session(windowId), input),
    ),
    command(
      C.cashiers.updateDisplayName,
      updateDisplayNameInputSchema,
      ({ windowId }, input) =>
        cashiers.updateDisplayName(session(windowId), input),
    ),
    command(
      C.cashiers.changeRole,
      changeRoleInputSchema,
      ({ windowId }, input) => cashiers.changeRole(session(windowId), input),
    ),
    command(
      C.cashiers.deactivate,
      cashierIdInputSchema,
      ({ windowId }, input) => cashiers.deactivate(session(windowId), input),
    ),
    command(
      C.cashiers.reactivate,
      cashierIdInputSchema,
      ({ windowId }, input) => cashiers.reactivate(session(windowId), input),
    ),
    command(
      C.cashiers.resetPassword,
      resetPasswordInputSchema,
      ({ windowId }, input) => cashiers.resetPassword(session(windowId), input),
    ),
  ];
}
