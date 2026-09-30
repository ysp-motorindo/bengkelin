import { useEffect, useRef, useState } from 'react';

/**
 * Local input state that follows the server value only while the field has
 * no unsent/unacknowledged input: the cashier's newer local value always
 * wins over an older response. `serverKey` identifies the server value
 * (for arrays/objects whose identity changes on every view).
 */
export function useSyncedValue<T>(
  serverValue: T,
  isDirty: () => boolean,
  serverKey: string = String(serverValue),
): [T, (value: T) => void] {
  const [local, setLocal] = useState(serverValue);
  const dirty = useRef(isDirty);
  dirty.current = isDirty;
  const latest = useRef(serverValue);
  latest.current = serverValue;

  useEffect(() => {
    if (!dirty.current()) setLocal(latest.current);
  }, [serverKey]);

  return [local, setLocal];
}
