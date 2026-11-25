import { useCallback, useState } from "react";

/**
 * A yes/no a person sets on this computer (a folded section, say), kept in local storage. It starts
 * at `initial` when storage is empty or unavailable, and a failed write keeps the value for the session.
 */
export function useStoredFlag(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Storage is off (a private window): the choice holds until the window closes.
      }
    },
    [key],
  );
  return [value, set];
}
