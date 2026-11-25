import { useCallback, useMemo, useState } from "react";
import { useQueries } from "convex/react";
import { api } from "./api";
import { mergeThreadPages } from "./chat";

type ThreadPage = (typeof api.messages.unreadThreads)["_returnType"];
export type UnreadThreadRow = ThreadPage["page"][number];

/**
 * A channel's threads with replies you haven't read (messages.unreadThreads), whether or not their
 * messages are loaded, ten at a time: `loadMore()` asks for the next page. A moved read point, or
 * another channel, starts the list over. `loading` while the first page hasn't come; `complete`
 * once every thread is listed; `reordered` when new replies moved threads so a page loaded after
 * another no longer follows it (load more to ask for it again).
 */
export function useUnreadThreads(teamId: string, channelId: string, readSeq: number, enabled: boolean) {
  const [asked, setAsked] = useState<{ channelId: string; readSeq: number; cursors: string[] }>({ channelId, readSeq, cursors: [] });
  const cursors = asked.channelId === channelId && asked.readSeq === readSeq ? asked.cursors : [];
  // useQueries subscribes anew whenever this object changes, so it's made once per set of pages
  // (a new object each render makes React re-render without end).
  const cursorKey = cursors.join("\n");
  const requests = useMemo(
    () =>
      enabled
        ? Object.fromEntries(
            [null, ...(cursorKey ? cursorKey.split("\n") : [])].map((cursor, i) => [
              String(i),
              { query: api.messages.unreadThreads, args: { teamId, channelId, cursor, limit: 10 } },
            ]),
          )
        : {},
    [enabled, cursorKey, teamId, channelId],
  );
  const pages = useQueries(requests);
  const list = mergeThreadPages(
    cursors,
    [null, ...cursors].map((_, i) => {
      const page = pages[String(i)] as ThreadPage | Error | undefined;
      return page instanceof Error ? undefined : page;
    }),
  );
  const next = list.next;
  const keptKey = list.cursors.join("\n");
  const loadMore = useCallback(() => {
    if (next === null) return;
    setAsked({ channelId, readSeq, cursors: [...(keptKey ? keptKey.split("\n") : []), next] });
  }, [next, keptKey, channelId, readSeq]);
  return {
    threads: enabled ? list.threads : [],
    loading: enabled && pages["0"] === undefined,
    complete: !enabled || list.complete,
    next,
    reordered: list.cursors.length < cursors.length,
    loadMore,
  };
}
