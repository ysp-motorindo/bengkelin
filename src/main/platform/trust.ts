/**
 * Pure trust rules for the renderer. Kept free of Electron imports so they can
 * be unit tested under plain Node.
 */
export interface TrustedAppLocation {
  /** Vite dev server URL; only set in development. */
  devServerUrl?: string;
  /** file:// URL of the bundled renderer index.html; used in built apps. */
  indexFileUrl?: string;
}

/**
 * True only for the application's own renderer document: the dev-server origin
 * in development, or exactly the bundled index.html in built apps (hash and
 * query are ignored). Everything else - remote, data:, about:blank, other
 * local files, malformed input - is untrusted.
 */
export function isTrustedAppUrl(
  url: string,
  location: TrustedAppLocation,
): boolean {
  let candidate: URL;
  try {
    candidate = new URL(url);
  } catch {
    return false;
  }

  if (location.devServerUrl) {
    return candidate.origin === new URL(location.devServerUrl).origin;
  }
  if (location.indexFileUrl) {
    const index = new URL(location.indexFileUrl);
    return (
      candidate.protocol === 'file:' &&
      candidate.host === index.host &&
      candidate.pathname === index.pathname
    );
  }
  return false;
}
