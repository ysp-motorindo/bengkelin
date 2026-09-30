// The production Electron fuses, flipped into every packaged binary by
// forge.config.mts and verified on the packaged output by
// `npm run release:check`. One source of truth for both.
//
// `strictlyRequireAllFuses` makes packaging fail when an Electron upgrade
// adds a fuse this list does not decide yet (review it, then add it here).
import { FuseV1Options, FuseVersion } from '@electron/fuses';

export const PRODUCTION_FUSE_SETTINGS = {
  // ELECTRON_RUN_AS_NODE cannot turn the app into a plain Node runtime.
  [FuseV1Options.RunAsNode]: false,
  // Cookies are encrypted at rest with the OS keychain.
  [FuseV1Options.EnableCookieEncryption]: true,
  // NODE_OPTIONS / NODE_EXTRA_CA_CERTS are ignored.
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  // --inspect / --inspect-brk are ignored (this is also why Playwright
  // cannot drive the packaged app; see docs/testing/client-trial-checklist.md).
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // app.asar is validated against the hash embedded at package time
  // (enforced by Electron on macOS and Windows).
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  // The app is loaded only from app.asar (no loose app/ folder).
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  // Electron's default; no separate browser-process snapshot is shipped.
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // Electron's default. The renderer is loaded from file:// (loadFile) as
  // ES modules, which needs file:// to keep its extra privileges.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  // Electron's default (WebAssembly trap handlers; no security downside).
  [FuseV1Options.WasmTrapHandlers]: true,
} as const satisfies Record<FuseV1Options, boolean>;

export const PRODUCTION_FUSES = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  ...PRODUCTION_FUSE_SETTINGS,
} as const;
