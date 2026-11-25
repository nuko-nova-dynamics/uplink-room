import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Where a list opens (spec #63), decided once per mount, so key the list by what it shows (a
 * thread by its parent). With a navigation `target` (a reply opened from search or a banner) it
 * opens there: `toTarget(target)`, then `consume()`, which clears the target. Without one it opens
 * wherever `start()` puts it (the first reply you haven't read, or the newest). After that only a
 * new navigation moves it: setting `target` again positions it again. New replies, edits and
 * reactions never move the scroll, and clearing the target never sends it to the start.
 */
export function useOpenPlace<T>(
  target: T | undefined,
  ready: boolean,
  toTarget: (target: T) => void,
  consume: () => void,
  start: () => void,
) {
  const opened = useRef(false);
  const latest = useRef({ toTarget, consume, start });
  latest.current = { toTarget, consume, start };
  useLayoutEffect(() => {
    if (!ready) return;
    if (target !== undefined) {
      opened.current = true;
      latest.current.toTarget(target);
      latest.current.consume();
    } else if (!opened.current) {
      opened.current = true;
      latest.current.start();
    }
  }, [target, ready]);
}

/** How close to its end a list counts as being at its end. */
const AT_END_PX = 80;

/**
 * A list that follows new items while you're at its end, as a channel follows new messages (the
 * Replies panel). The first load isn't new: where the list opens is useOpenPlace's to decide, so call
 * this after useOpenPlace. `measure(el)` records whether the list is at its end: call it after the
 * open placement and on every scroll. `count` is undefined while the items load.
 */
export function useFollowNew(scroller: RefObject<HTMLElement | null>, count: number | undefined): (el: HTMLElement) => void {
  const atEnd = useRef(true);
  const last = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (count === undefined) return;
    const el = scroller.current;
    if (el && last.current !== undefined && count > last.current && atEnd.current) el.scrollTop = el.scrollHeight;
    last.current = count;
  }, [count, scroller]);
  // And keep to the end when what's there grows after it came (an image loading, a preview) or the
  // list itself resizes, as the channel does. Its rows are observed afresh as replies come.
  useEffect(() => {
    const el = scroller.current;
    if (!el || count === undefined || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (last.current !== undefined && atEnd.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [count, scroller]);
  return useCallback((el: HTMLElement) => {
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
  }, []);
}
