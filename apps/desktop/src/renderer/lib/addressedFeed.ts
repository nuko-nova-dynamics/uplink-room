import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { messageNotices, type MessageNotices, type MessageWatch } from "./messageSignals";
import { useRoomQuery } from "./session";

/** How many alerts one page of the feed asks for (messages.addressed takes at most 50). */
export const FEED_PAGE = 50;

/**
 * Messages addressed to you as they reach you, for banners and the sound (spec #63). The first
 * list, the newest, only sets where the feed starts, so what was there when the app opened shows
 * nothing. After that it reads `messages.addressed` after the last seq handled, oldest first, one
 * page at a time, and moves on only once a page is handled. A backlog bigger than a page (the
 * computer slept, the connection dropped) is shown in full and in order, never skipped.
 */
export function useAddressedNotices(watch: () => MessageWatch, onNotices: (found: MessageNotices) => void) {
  const [after, setAfter] = useState<number | null>(null);
  const page = useRoomQuery(api.messages.addressed, after === null ? {} : { after, limit: FEED_PAGE });
  const handled = useRef<number | null>(null);
  const latest = useRef({ watch, onNotices });
  latest.current = { watch, onNotices };
  useEffect(() => {
    if (!page) return;
    // Anything at or below what was handled is left out, so a page seen twice shows nothing twice.
    const found = messageNotices(page, latest.current.watch(), handled.current);
    handled.current = found.boundary;
    latest.current.onNotices(found);
    setAfter(found.boundary);
  }, [page]);
}
