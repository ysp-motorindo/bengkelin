import { useEffect, useState } from 'react';

/** Times on history screens are shown in the shop timezone (spec 33, A.5). */
export function useShopTimezone(): string | null {
  const [timezone, setTimezone] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.bengkelin.settings
      .getShop()
      .then((result) => {
        if (live)
          setTimezone(result.ok ? result.value.timezone : 'Asia/Jakarta');
      })
      .catch(() => {
        if (live) setTimezone('Asia/Jakarta');
      });
    return () => {
      live = false;
    };
  }, []);
  return timezone;
}
