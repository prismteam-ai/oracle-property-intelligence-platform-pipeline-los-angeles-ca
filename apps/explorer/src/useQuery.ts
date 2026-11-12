import { useEffect, useRef, useState } from "react";

/**
 * Minimal async state hook (no extra dependency). `key` identifies the query inputs; "loading" is derived
 * (the key has no settled result yet), so state changes only happen in the async callbacks.
 */
export function useQuery<T>(
  fn: () => Promise<T>,
  key: string,
): { data?: T; error?: string; loading: boolean } {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const [s, set] = useState<{ key?: string; data?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    fnRef.current().then(
      (data) => live && set({ key, data }),
      (e: Error) => live && set({ key, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return s.key === key
    ? { data: s.data, error: s.error, loading: false }
    : { loading: true };
}
