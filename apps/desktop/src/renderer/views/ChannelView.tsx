import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Covered } from "../lib/covered";
import { useMutation, usePaginatedQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { PaginatedQueryReference } from "convex/react";
import { STATE_META } from "../lib/states";
import { api, type ChannelRow, type Id, type MessageRow, type SearchResult } from "../lib/api";
import {
  continuesRun,
  dayLabel,
  firstUnreadReply,
  lastEditable,
  newReadMemory,
  latestOfRuns,
  openingAtMessage,
  readThrough,
  sameDay,
  sendReadMark,
  memberMentionables,
  runMentionables,
  groupPart,
  unreadMark,
  wroteIt,
  type MentionMember,
  type ReadMemory,
  type ReadPane,
  type UnreadThread,
} from "../lib/chat";
import { useFollowNew, useOpenPlace } from "../lib/positionOnce";
import { useUnreadThreads } from "../lib/unreadThreads";
import { useAct, useRoomQuery, useSession, useSoftRoomQuery } from "../lib/session";
import { ConversationFace as MemberFace } from "../components/chat/ConversationFace";
import { Icon } from "../components/Icon";
import { LinkMascot } from "../characters/LinkMascot";
import { HarnessMark } from "../components/Faces";
import { BrowserButton, BrowserDock } from "./browser/BrowserDock";
import { CallBar, CallHeaderActions, CallStage } from "../components/Call";
import {
  CallEvent,
  ProposedTasks,
  TranscriptPanel,
  type ChannelCall,
} from "../components/CallTimeline";
import { useCall, useLiveCalls } from "../lib/call";
import { callActionsPlace } from "../lib/timeline";
import type { Nav } from "../Shell";
import { Empty } from "../components/Empty";
import { MessageItem, MessageRows } from "../components/chat/MessageItem";
import { Composer, fileDrop, type ComposerHandle } from "../components/chat/Composer";
import { OutputHeadNote } from "../components/chat/OutputWarning";
import { NewDivider } from "../components/chat/InlineEditor";
import { ChannelMembers } from "../components/chat/ChannelMembers";
import { PeoplePanel } from "../components/People";
import { useStoredFlag } from "../lib/storedFlag";
import { ResultPage, type SearchSpec } from "./SearchView";
import { presenceLabel, usePresence } from "../lib/presence";
import { useNow } from "../components/useNow";
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItem,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { Separator } from "@ui-sdk/react/separator";
import { Toggle } from "@ui-sdk/react/toggle";
import { Tip } from "../components/Tip";

type TimelineItem =
  | { kind: "message"; at: number; message: MessageRow }
  | { kind: "call"; at: number; call: ChannelCall; event: "started" | "ended" };

/** messages.list follows Convex's pagination when the app passes `paginationOpts` (usePaginatedQuery). */
const pagedMessages = api.messages.list as unknown as PaginatedQueryReference;
const PAGE = 50;
/** How many messages the channel loads on its own to reach where you had read up to. */
const AUTO_UNREAD = 400;

/** A scrolling list's message rows and visible box, or null while it isn't showing (no height). */
function paneOf(el: HTMLElement | null): ReadPane | null {
  if (!el || el.clientHeight === 0) return null;
  const box = el.getBoundingClientRect();
  const rows = [...el.querySelectorAll<HTMLElement>("[data-message][data-seq]")].map((node) => {
    const r = node.getBoundingClientRect();
    return {
      messageId: node.dataset["message"]!,
      seq: Number(node.dataset["seq"]),
      top: r.top,
      bottom: r.bottom,
    };
  });
  return { rows, viewport: { top: box.top, bottom: box.bottom } };
}

/** How the channel is named in its header and elsewhere: #name, or a direct message's other members. */
export function channelTitle(channel: Pick<ChannelRow, "kind" | "name"> | undefined): string {
  if (!channel) return "Channel";
  // A private channel shows a lock where a team channel shows #, so its name goes without the #.
  return channel.kind === "channel" ? `#${channel.name}` : channel.name;
}

/**
 * A channel or direct message (spec #3, spec #63): its messages, newest at the bottom, loading
 * older ones as you scroll up back to the first; a "new" divider where you had read up to; the
 * message a link or banner points at, opened in place and highlighted; and calls, replies,
 * pins and the shared browser beside it.
 */
export function ChannelView({
  channelId,
  focus,
  search,
  nav,
}: {
  channelId: Id<"channels">;
  /** A message to open the channel at (from a banner, a search result or a link). */
  focus?: Id<"messages"> | undefined;
  /** The search a result was opened from: its results show beside the channel. */
  search?: SearchSpec | undefined;
  nav: Nav;
}) {
  const session = useSession();
  const me = session.me.memberId;
  const channels = useRoomQuery(api.channels.list, {});
  const channel = channels?.find((c) => c.channelId === channelId);
  const calls = useRoomQuery(api.calls.list, { channelId, limit: 30 });
  const live = useLiveCalls();
  const myCall = useCall();
  const liveCall = live?.find((c) => c.channelId === channelId);
  const onStage = myCall.channelId === channelId && myCall.status !== "idle" && liveCall;
  // Reading through the newest message clears the channel's count at once, not a round trip later,
  // so a channel you're looking at never shows a count while a new message comes in.
  const seqOf = useRef(new Map<string, number>());
  const markReadNow = useMutation(api.channels.markRead).withOptimisticUpdate((store, args) => {
    const rows = store.getQuery(api.channels.list, { teamId: args.teamId });
    if (!rows) return;
    store.setQuery(
      api.channels.list,
      { teamId: args.teamId },
      rows.map((row) => {
        if (row.channelId !== args.channelId) return row;
        const seq = args.upTo ? (seqOf.current.get(args.upTo) ?? 0) : row.lastSeq;
        if (seq < row.lastSeq) return row;
        return { ...row, readSeq: Math.max(row.readSeq, seq), unread: 0, mentions: 0 };
      }),
    );
  });
  const markRead = useCallback(
    async (args: { channelId: Id<"channels">; upTo?: Id<"messages"> }) => {
      try {
        await markReadNow({ teamId: session.teamId, ...args });
      } catch {
        // Read marks are retried with the next scroll or message; a failure isn't worth a toast.
      }
    },
    [markReadNow, session.teamId],
  );
  const markSeen = useAct(api.channels.markSeen);
  const markUnread = useAct(api.channels.markUnread);
  // After Mark unread, the channel stays unread while you look at it, as in Discord: read marks wait
  // until you leave it (or post, which marks it read in the room).
  const [holdRead, setHoldRead] = useState(false);
  // Under Settings the channel stays mounted but unseen: nothing in it is marked read.
  const covered = useContext(Covered);
  const composer = useRef<ComposerHandle>(null);

  const [side, setSide] = useState<
    | { kind: "replies"; parent: Id<"messages">; highlight?: Id<"messages"> }
    | { kind: "transcript"; callId: Id<"calls"> }
    | { kind: "pins" }
    | { kind: "search"; spec: SearchSpec }
    | null
  >(search ? { kind: "search", spec: search } : null);
  // The search as you left it: the filters and order you changed in the panel since opening, so
  // Back from a thread brings back those results, not the ones the route first named.
  const [searchSpec, setSearchSpec] = useState(search);
  // Each result opened from search brings the results back beside it.
  useEffect(() => {
    if (search) setSearchSpec(search);
    if (search)
      setSide((s) =>
        s?.kind === "replies" && s.highlight === focus ? s : { kind: "search", spec: search },
      );
  }, [search, focus]);
  const [browser, setBrowser] = useState<"closed" | "side" | "full">("closed");
  // People (Discord's member list) sits beside the channel whenever no other panel does; it stays
  // open or closed as you last left it, on this computer.
  const [peopleOpen, setPeopleOpen] = useStoredFlag("uplink.channel.people", true);
  const showPeople = peopleOpen && !side && browser === "closed";
  // Files dragged over the channel: say where they'll go. Reset on any drop or drag end, wherever it
  // lands (a reply's composer takes its own drop and stops it there).
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    const reset = () => {
      dragDepth.current = 0;
      setDropping(false);
    };
    window.addEventListener("drop", reset, true);
    window.addEventListener("dragend", reset, true);
    return () => {
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("dragend", reset, true);
    };
  }, []);
  // Where the view is: off the bottom at all, and more than a screenful and a half up.
  const [place, setPlace] = useState<{ off: boolean; far: boolean }>({ off: false, far: false });
  // The New line scrolled up out of view: where the list starts, for the bar that says so.
  const [newAbove, setNewAbove] = useState<number | null>(null);
  // The message being edited in the list: ↑ in the empty composer opens your last one.
  const [editingId, setEditingId] = useState<Id<"messages"> | null>(null);

  // Who can be mentioned here: a direct message's or private channel's members, or the whole team,
  // and the live runs that can be messaged here (ADR 0026).
  const liveRuns = useRoomQuery(api.runs.live, {});
  const members = useMemo<MentionMember[]>(() => {
    const listed = channel?.kind === "direct" || channel?.kind === "private";
    const people = memberMentionables(
      listed ? (channel.members ?? []) : session.members,
      session.members,
    );
    const place = listed
      ? {
          members: channel.members ?? [],
          runs: channel.kind === "direct" ? channel.runs : undefined,
        }
      : null;
    return [...people, ...runMentionables(liveRuns ?? [], place)];
  }, [channel, session.members, liveRuns]);
  // The app is used by people, and people may write @everyone.
  const everyone = true;

  // Where you had read up to when you opened the channel: the "new" divider stays there.
  const [readAtOpen, setReadAtOpen] = useState<number | undefined>(undefined);
  // With nothing unread at open there is no divider, even for messages that arrive while you read.
  useEffect(() => {
    if (channel && readAtOpen === undefined)
      setReadAtOpen(channel.unread > 0 ? channel.readSeq : Number.POSITIVE_INFINITY);
  }, [channel, readAtOpen]);

  // Newest first from the backend; shown oldest first.
  const paged = usePaginatedQuery(
    pagedMessages,
    { teamId: session.teamId, channelId },
    { initialNumItems: PAGE },
  );
  const liveMessages = useMemo(
    () => [...(paged.results as MessageRow[])].reverse(),
    [paged.results],
  );
  for (const m of liveMessages) if (m.seq !== undefined) seqOf.current.set(m.messageId, m.seq);

  // Opening at a message: a reply opens its thread beside the message it answers.
  const [target, setTarget] = useState<Id<"messages"> | null>(focus ?? null);
  useEffect(() => setTarget(focus ?? null), [focus]);
  // Null when it's gone (deleted since you were sent to it): then there's nothing to open at.
  // A link can carry anything after /message/: an id the room refuses counts as gone, not as a
  // failure that takes the channel down.
  const fetchedTarget = useSoftRoomQuery(
    api.messages.get,
    target ? { messageId: target } : "skip",
    null,
  );
  // A link can name this channel with a message from another one: that's nothing to open at here,
  // or the view would show the other channel's messages under this one's header and composer.
  const targetMessage =
    fetchedTarget && fetchedTarget.channelId !== channelId ? null : fetchedTarget;
  useEffect(() => {
    if (target && targetMessage === null) setTarget(null);
  }, [target, targetMessage]);
  const anchor = targetMessage ? (targetMessage.replyTo ?? targetMessage.messageId) : null;
  // Once per target, by id: an edit or a reaction gives a new targetMessage but isn't a navigation.
  const targetId = targetMessage?.messageId;
  const targetParent = targetMessage?.replyTo;
  useEffect(() => {
    if (targetId && targetParent)
      setSide({ kind: "replies", parent: targetParent, highlight: targetId });
  }, [targetId, targetParent]);
  const anchorLoaded = anchor !== null && liveMessages.some((m) => m.messageId === anchor);
  const around = useRoomQuery(
    api.messages.around,
    anchor && !anchorLoaded ? { messageId: anchor } : "skip",
  );
  useEffect(() => {
    if (around === null) setTarget(null);
  }, [around]);
  const mode: "live" | "around" = anchor && !anchorLoaded && around ? "around" : "live";
  const messages = mode === "around" ? around!.messages : liveMessages;
  const latestRuns = useMemo(() => latestOfRuns(messages), [messages]);

  const items: TimelineItem[] = [];
  for (const message of messages) items.push({ kind: "message", at: message.postedAt, message });
  const oldestShown = messages[0]?.postedAt ?? 0;
  const newestShown = messages.at(-1)?.postedAt ?? 0;
  // Call events show among the messages loaded, so an old call doesn't pile up at the top.
  const inView = (at: number) =>
    mode === "around"
      ? at >= oldestShown && at <= newestShown
      : paged.status === "Exhausted" || messages.length === 0 || at >= oldestShown;
  for (const call of calls ?? []) {
    if (inView(call.startedAt))
      items.push({ kind: "call", at: call.startedAt, call, event: "started" });
    if (call.endedAt !== undefined && inView(call.endedAt))
      items.push({ kind: "call", at: call.endedAt, call, event: "ended" });
  }
  items.sort((a, b) => a.at - b.at);
  const shownMessageIds = new Set(messages.map((m) => m.messageId as string));
  const notesOf = new Map(
    (calls ?? [])
      .filter((c) => callActionsPlace(c, shownMessageIds) === "notes")
      .map((c) => [c.notesMessageId!, c]),
  );
  // The "new" divider goes where you had read up to, once that point is loaded; until then,
  // older pages load (up to AUTO_UNREAD messages) and a note says unread messages go on above.
  const mark = unreadMark(
    messages,
    readAtOpen,
    me,
    mode === "around" ? !around?.hasOlder : paged.status === "Exhausted",
  );
  const divider = mark && "before" in mark ? mark.before : null;
  const unreadAbove = mark !== null && "above" in mark;

  // ---- scrolling ----
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const heightBeforeOlder = useRef<number | null>(null);
  const [highlight, setHighlight] = useState<Id<"messages"> | null>(null);
  // The message the older stretch was last scrolled to, so read tracking knows it has arrived.
  const [positionedAt, setPositionedAt] = useState<Id<"messages"> | null>(null);
  useEffect(() => {
    if (mode !== "around") setPositionedAt(null);
  }, [mode]);
  const newest = messages.at(-1)?.messageId;
  const oldest = messages[0]?.messageId;

  // Keep the view where it was when older messages load above it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || heightBeforeOlder.current === null) return;
    el.scrollTop += el.scrollHeight - heightBeforeOlder.current;
    heightBeforeOlder.current = null;
  }, [oldest]);

  // Follow new messages while you're at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || anchor || mode === "around") return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [newest, items.length, anchor, mode]);
  // And keep to the bottom when what's there grows: an image loading, a reaction, a preview.
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    const content = inner.current;
    if (!el || !content || anchor || mode === "around") return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    // The list itself shrinks when the composer grows (Shift+Enter, files): keep the newest in view.
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor, mode]);

  // Opening with unread messages puts the "new" divider near the top, so you read on from where you
  // left off; with everything new fitting on screen it stays at the bottom. Once per opening, and
  // never when opened at a message (a banner or search result positions itself).
  const placedDivider = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !divider || anchor || mode === "around" || placedDivider.current) return;
    placedDivider.current = true;
    const line = el.querySelector<HTMLElement>(".new-divider");
    if (!line) return;
    const top = line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    if (top < el.scrollHeight - el.clientHeight) {
      el.scrollTop = Math.max(0, top - 48);
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }
  }, [divider, anchor, mode]);

  // Open at the target message, highlighted for a moment. A target already among the newest
  // messages has done its job once it's in view: the channel goes back to following new
  // messages when you scroll to the bottom. One further back stays open around it (mode
  // "around") until you jump to the newest or scroll to the end of what's there.
  useEffect(() => {
    if (!anchor || !(anchorLoaded || mode === "around")) return;
    const el = scroller.current?.querySelector(`[data-message="${anchor}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    setHighlight(anchor);
    atBottom.current = false;
    if (anchorLoaded) setTarget(null);
    else setPositionedAt(anchor);
  }, [anchor, anchorLoaded, mode]);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 2600);
    return () => clearTimeout(timer);
  }, [highlight]);

  const loadOlder = useCallback(() => {
    if (mode !== "live" || paged.status !== "CanLoadMore") return;
    heightBeforeOlder.current = scroller.current?.scrollHeight ?? null;
    paged.loadMore(PAGE);
  }, [mode, paged]);

  // Read through the newest message actually on screen: after the messages loaded, with the
  // window in front and the channel's column showing (not behind the full-size browser), and not
  // while it is still on its way to a message it was opened at.
  const readSeq = channel?.readSeq ?? 0;
  const loaded =
    paged.status !== "LoadingFirstPage" &&
    channel !== undefined &&
    !openingAtMessage(target, mode, anchor, positionedAt);
  const visible = browser !== "full";
  // What has been on screen in each channel this session, and how far its read point was moved.
  const memories = useRef(new Map<string, { memory: ReadMemory }>());
  let memo = memories.current.get(channelId);
  if (!memo) {
    memo = { memory: newReadMemory() };
    memories.current.set(channelId, memo);
  }
  const memory = memo;
  // The latest maybeMarkRead, for a retry after a refused read mark.
  const retryMarkRead = useRef<() => void>(() => {});
  // How far each thread has been seen in the Replies panel (memory.threadThrough), for the strip.
  const [threadSeen, setThreadSeen] = useState<Record<string, number>>({});
  // Set each render below: the threads with unread replies, and whether the list has them all.
  const threadsRef = useRef<{ threads: UnreadThread[] | null; complete: boolean }>({
    threads: null,
    complete: false,
  });
  const markedSeen = useRef(new Set<string>());
  const repliesScroller = useRef<HTMLDivElement>(null);
  // Whether the channel's list reaches its newest message (not opened at an older stretch).
  const complete = mode === "live" || (around !== undefined && around !== null && !around.hasNewer);
  // Whether the loaded messages go back to the read point, so none between it and them is missed.
  const reachesReadRef = useRef(false);
  reachesReadRef.current =
    (mode === "around" ? !around?.hasOlder : paged.status === "Exhausted") ||
    messages.some((m) => m.seq !== undefined && !m.system && m.seq <= readSeq);
  const openThread = side?.kind === "replies" ? (side.parent as string) : null;
  const maybeMarkRead = useCallback(() => {
    const main = paneOf(scroller.current);
    if (!loaded || !visible || !document.hasFocus() || !main || holdRead || covered) return;
    // What's on screen in the channel's own list and, when open, the Replies panel: the read point
    // moves only through what has all been seen (readThrough).
    const pane = paneOf(repliesScroller.current);
    const panel =
      pane && openThread
        ? {
            ...pane,
            parentId: openThread,
            loaded: repliesScroller.current?.dataset["loaded"] === "true",
          }
        : null;
    const { upTo, seen } = readThrough(memory.memory, {
      readSeq: Math.max(readSeq, memory.memory.marked),
      main: { ...main, complete, reachesRead: reachesReadRef.current },
      replies: panel,
      threads: threadsRef.current.threads,
      threadsComplete: threadsRef.current.complete,
    });
    // How far the open thread has been seen, so the strip stops offering it even while the read
    // point waits behind another thread.
    const through = openThread ? memory.memory.threadThrough.get(openThread) : undefined;
    if (openThread && through !== undefined)
      setThreadSeen((t) => ((t[openThread] ?? 0) >= through ? t : { ...t, [openThread]: through }));
    if (upTo) {
      // Recorded only once the room takes it. A message deleted since it was on screen is passed
      // over at once for the newest one before it; any other failure is tried again shortly.
      void sendReadMark(
        memory.memory,
        upTo,
        (id) => markReadNow({ teamId: session.teamId, channelId, upTo: id as Id<"messages"> }),
        (error) =>
          error instanceof ConvexError &&
          (error.data as { code?: string } | undefined)?.code === "not_found",
      ).then((result) => {
        if (result === "gone") retryMarkRead.current();
        else if (result === "failed") setTimeout(() => retryMarkRead.current(), 3000);
      });
    }
    const fresh = seen.filter((id) => !markedSeen.current.has(id));
    if (fresh.length) {
      for (const id of fresh) markedSeen.current.add(id);
      void markSeen({ channelId, messageIds: fresh as Id<"messages">[] });
    }
  }, [
    loaded,
    visible,
    complete,
    readSeq,
    markReadNow,
    session.teamId,
    markSeen,
    channelId,
    memory,
    openThread,
    holdRead,
    covered,
  ]);
  retryMarkRead.current = maybeMarkRead;
  useEffect(() => {
    maybeMarkRead();
    window.addEventListener("focus", maybeMarkRead);
    return () => window.removeEventListener("focus", maybeMarkRead);
  }, [maybeMarkRead, items.length, newest]);
  // Load older pages until where you had read up to is in view (bounded), for the divider.
  useEffect(() => {
    if (
      unreadAbove &&
      mode === "live" &&
      paged.status === "CanLoadMore" &&
      messages.length < AUTO_UNREAD
    )
      loadOlder();
  }, [unreadAbove, mode, paged.status, messages.length, loadOlder]);

  // Whether the New line is above what's on screen, and where the list's top is for the bar.
  const checkNewAbove = useCallback(() => {
    const el = scroller.current;
    const line = el?.querySelector<HTMLElement>(".new-divider");
    const above =
      !!el && !!line && line.getBoundingClientRect().bottom < el.getBoundingClientRect().top + 4;
    setNewAbove(above ? el!.offsetTop : null);
  }, []);
  useLayoutEffect(() => checkNewAbove(), [checkNewAbove, divider, items.length]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    checkNewAbove();
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    const off = below > 80;
    const far = below > el.clientHeight * 1.5;
    setPlace((p) => (p.off === off && p.far === far ? p : { off, far }));
    // Ask for the older page while a screenful and a half is still above, so scrolling up doesn't stall at the top.
    if (el.scrollTop < el.clientHeight * 1.5) loadOlder();
    // At the end of an older stretch that reaches the newest message: back to following.
    if (atBottom.current && mode === "around" && around && !around.hasNewer) setTarget(null);
    maybeMarkRead();
  };

  const toNewest = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setPlace({ off: false, far: false });
  };
  // Read through the newest: the New line goes with it, so marking read shows on screen.
  const markAllRead = () => {
    setHoldRead(false);
    if ((channel?.unread ?? 0) > 0) void markRead({ channelId });
    setReadAtOpen(Number.POSITIVE_INFINITY);
  };
  // Escape in the empty composer: read through the newest, as in Discord.
  const readAll = () => {
    markAllRead();
    if (mode === "live") toNewest();
  };
  // Threads with replies you haven't read, whether or not their messages are loaded: the room
  // finds them from each parent's newest reply and counts from the newest back, bounded. Ten at a
  // time: the next page loads once the strip has offered every thread listed.
  const unreadThreads = useUnreadThreads(
    session.teamId,
    channelId,
    readSeq,
    (channel?.unread ?? 0) > 0,
  );
  const { loadMore: loadMoreThreads } = unreadThreads;
  threadsRef.current = {
    threads: unreadThreads.loading
      ? null
      : unreadThreads.threads.map((t) => ({
          parentId: t.message.messageId,
          lastReplySeq: t.message.lastReplySeq,
          firstNewSeq: t.firstNewSeq,
        })),
    complete: unreadThreads.complete,
  };
  // Threads not yet seen through their newest reply.
  const threads = unreadThreads.threads.filter(
    (t) =>
      Math.max(
        threadSeen[t.message.messageId] ?? 0,
        memory.memory.threadThrough.get(t.message.messageId) ?? 0,
      ) < (t.message.lastReplySeq ?? Number.POSITIVE_INFINITY),
  );
  const waitingThreads = threads.filter((t) => t.message.messageId !== openThread);
  // Load the next page once every listed thread is open or seen, or when new replies reordered
  // the pages loaded after one.
  const wantNext =
    unreadThreads.next !== null && (waitingThreads.length === 0 || unreadThreads.reordered);
  useEffect(() => {
    if (wantNext) loadMoreThreads();
  }, [wantNext, loadMoreThreads]);
  const newRepliesOf = new Map(
    threads.map((t) => [t.message.messageId as string, { count: t.newReplies, more: t.moreNew }]),
  );
  // A message arriving while you're scrolled up, with no divider yet, gets one above it: where you
  // were read up to when it came.
  const lastNewest = useRef<string | undefined>(undefined);
  useEffect(() => {
    const newestId = messages.at(-1)?.messageId;
    const arrived = lastNewest.current !== undefined && newestId !== lastNewest.current;
    lastNewest.current = newestId;
    if (
      arrived &&
      mode === "live" &&
      !atBottom.current &&
      readAtOpen === Number.POSITIVE_INFINITY
    ) {
      // A divider for this arrival marks the place; it never moves the view the way opening does.
      placedDivider.current = true;
      setReadAtOpen(readSeq);
    }
  }, [messages, mode, readAtOpen, readSeq]);
  // Unread messages below the view (not yet on screen, so not read): the way down says how many.
  const unreadBelow = messages.filter(
    (m) => m.seq !== undefined && m.seq > readSeq && !wroteIt(m, me) && !m.system,
  ).length;

  const jumpTo = (messageId: Id<"messages">) => {
    setTarget(messageId);
    atBottom.current = false;
  };
  const backToPresent = () => {
    setTarget(null);
    atBottom.current = true;
    nav.go({ name: "channel", channelId });
  };

  const sideParent = side?.kind === "replies" && browser === "closed" ? side.parent : undefined;
  const loadedParent = sideParent
    ? (messages.find((m) => m.messageId === sideParent) ??
      (targetMessage?.messageId === sideParent ? targetMessage : undefined))
    : undefined;
  // A thread opened from the strip can belong to a message far above what's loaded.
  const fetchedParent = useRoomQuery(
    api.messages.get,
    sideParent && !loadedParent ? { messageId: sideParent } : "skip",
  );
  const parent = loadedParent ?? fetchedParent ?? undefined;
  // The Replies panel is on screen (it isn't once its parent is gone).
  const repliesShown = browser === "closed" && side?.kind === "replies" && Boolean(parent);
  const layout =
    browser === "full"
      ? "with-browser-full"
      : browser === "side"
        ? "with-browser"
        : side
          ? "with-replies"
          : showPeople
            ? "with-people"
            : "";
  // A panel opening or closing narrows or widens the list, and its messages reflow: one that was at
  // the newest stays there, after this layout and after the next frame's (images, fonts).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !atBottom.current || anchor || mode === "around") return;
    el.scrollTop = el.scrollHeight;
    const frame = requestAnimationFrame(() => {
      if (atBottom.current || el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
        el.scrollTop = el.scrollHeight;
        atBottom.current = true;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, side?.kind, anchor, mode]);
  const proposalsFor = (call: ChannelCall) => (
    <ProposedTasks
      call={call}
      channelProjectId={channel?.projectId}
      onOpenTask={(taskId) => nav.openTask(taskId)}
      onOpenTranscript={() => {
        setBrowser((b) => (b === "full" ? b : "closed"));
        setSide({ kind: "transcript", callId: call.callId });
      }}
    />
  );
  const title = channelTitle(channel);
  // A direct message shows whether the people in it are here (members.presence).
  const presenceOf = usePresence();
  const now = useNow(30_000);
  const others =
    channel?.kind === "direct" ? (channel.members ?? []).filter((m) => m.memberId !== me) : [];
  // The live runs a direct message was opened with (ADR 0026): shown with the members.
  const dmRuns = channel?.kind === "direct" ? (channel.runs ?? []) : [];
  // A run here whose output the whole team (or others outside) can see hears every message: said
  // in the header and above the message box (ADR 0039, amended 2026-11-05).
  const dmWarnings = dmRuns.flatMap((r) => (r.warning ? [r.warning] : []));
  const dmFileNote = filesNote(dmRuns);
  const roster = useRoomQuery(
    api.teams.roster,
    others.length === 1 && others[0]!.kind === "agent" ? {} : "skip",
  );
  const onlyAgent = roster?.find((r) => r.kind === "agent" && r.memberId === others[0]?.memberId);
  const onlyAgentMember = onlyAgent
    ? session.members.find((m) => m.memberId === others[0]?.memberId)
    : undefined;
  const facePresence = (memberId: string) => {
    const p = presenceOf(memberId);
    return { presence: p.presence, label: presenceLabel(p.presence, p.lastSeenAt, now) };
  };
  const onlyOther = others.length === 1 && others[0]!.kind === "person" ? others[0]! : null;
  // ↑ in the empty composer: your newest message here that can still be edited.
  const editLast = () => {
    const last = lastEditable(messages, me, mode);
    if (!last) return;
    setEditingId(last.messageId);
    scroller.current
      ?.querySelector(`[data-message="${last.messageId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };
  const stopEditing = () => {
    setEditingId(null);
    composer.current?.focus();
  };
  // Mark unread from a message: the New line moves above it, and the view stays where it is.
  const markUnreadFrom = (message: MessageRow) => {
    if (message.seq === undefined) return;
    setHoldRead(true);
    placedDivider.current = true;
    setReadAtOpen(message.seq - 1);
    void markUnread({ channelId, from: message.messageId }).then((done) => {
      if (done === undefined) setHoldRead(false);
    });
  };
  const replyTo = (messageId: Id<"messages">) => {
    setBrowser((b) => (b === "full" ? b : "closed"));
    setSide({ kind: "replies", parent: messageId });
  };

  return (
    // Every conversation reads as Grok Bot's: bubbles, yours on the right (DESIGN.md, Conversations).
    <MessageRows.Provider value={false}>
      <div
        className={`channel-layout ${layout}`}
        {...fileDrop((files) => composer.current?.addFiles(files))}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          dragDepth.current += 1;
          setDropping(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDropping(false);
        }}
      >
        {dropping ? (
          <div className="drop-overlay" aria-hidden="true">
            <span>
              <Icon name="paperclip" size={16} /> Drop to attach to {title}
            </span>
          </div>
        ) : null}
        <div className={`channel-col ${onStage ? "has-stage" : ""}`} hidden={browser === "full"}>
          <header className="main-head">
            {/* Who or what this is, as one group: a centered pill in a wide column, as Grok Bot's header. */}
            <div className="head-id">
              {channel?.kind === "direct" ? (
                <span className="dm-faces">
                  {dmRuns.slice(0, 3).map((r) => (
                    <HarnessMark key={r.runId} harness="run" size={24} title={r.label} />
                  ))}
                  {others.slice(0, Math.max(0, 3 - dmRuns.length)).map((m) => (
                    <MemberFace
                      key={m.memberId}
                      member={m}
                      members={session.members}
                      size={24}
                      presence={facePresence(m.memberId)}
                    />
                  ))}
                </span>
              ) : null}
              <h1 className="truncate">
                {!channel || channel.kind === "direct" ? null : (
                  <Icon
                    className="head-glyph"
                    name={channel.kind === "private" ? "lock" : "hash"}
                  />
                )}
                {channel?.kind === "private" ? (
                  <span className="sr-only">Private channel </span>
                ) : null}
                {channel ? channel.name : <span className="head-loading">Loading…</span>}
              </h1>
              {onlyAgent ? (
                // An agent's conversation says what it's on, as Muse and Grok Bot do under the agent's name.
                <span className="head-presence roster-line">
                  <span className={`state-${onlyAgent.state}`}>
                    {onlyAgent.state === "idle" ? "Idle" : STATE_META[onlyAgent.state].label}
                  </span>
                  {onlyAgent.line ? <span className="muted truncate">{onlyAgent.line}</span> : null}
                </span>
              ) : onlyOther ? (
                <span className="head-presence">{facePresence(onlyOther.memberId).label}</span>
              ) : null}
            </div>
            <OutputHeadNote runs={dmRuns} />
            <span className="grow" />
            {/* The controls come with the channel, so they don't appear one at a time while it loads. */}
            {channel ? (
              <>
                {channel.kind === "private" ? (
                  <ChannelMembers
                    channelId={channelId}
                    name={title}
                    members={channel.members ?? []}
                    createdBy={channel.createdBy}
                    onLeft={() => nav.go({ name: "inbox" })}
                  />
                ) : null}
                {/* Text controls first, icon-only controls last, at the window's edge (DESIGN.md, "Window chrome"). */}
                <CallHeaderActions channelId={channelId} call={liveCall} />
                <BrowserButton
                  channelId={channelId}
                  open={browser !== "closed"}
                  onToggle={() => setBrowser((b) => (b === "closed" ? "side" : "closed"))}
                />
                <Tip
                  label={
                    showPeople
                      ? "Hide people"
                      : repliesShown
                        ? "Close the replies to see people"
                        : "People: who's here and what they're doing"
                  }
                >
                  <Toggle
                    className="btn icon"
                    aria-label="People"
                    pressed={showPeople}
                    // Opening People would close Replies and lose a reply being written. It stays
                    // focusable, so its hint can say why.
                    disabled={repliesShown}
                    focusableWhenDisabled
                    onPressedChange={() => {
                      if (showPeople) return setPeopleOpen(false);
                      setPeopleOpen(true);
                      setSide(null);
                      setBrowser((b) => (b === "full" ? b : "closed"));
                    }}
                  >
                    <Icon name="people" />
                  </Toggle>
                </Tip>
                <Tip label="Pinned messages">
                  <Toggle
                    className="btn icon"
                    aria-label="Pinned messages"
                    pressed={side?.kind === "pins"}
                    onPressedChange={() =>
                      setSide((s) => (s?.kind === "pins" ? null : { kind: "pins" }))
                    }
                  >
                    <Icon name="pushpin" />
                  </Toggle>
                </Tip>
                <ChannelMenu channel={channel} onMarkRead={markAllRead} />
              </>
            ) : null}
          </header>
          {liveCall ? (
            <CallBar call={liveCall} channelId={channelId} controls={browser !== "full"} />
          ) : null}
          {onStage ? <CallStage call={liveCall} /> : null}
          {divider && newAbove !== null
            ? (() => {
                const first = messages.find((m) => m.messageId === divider);
                const fresh = first
                  ? messages.filter(
                      (m) => m.postedAt >= first.postedAt && !m.system && !wroteIt(m, me),
                    ).length
                  : 0;
                return (
                  <div className="unread-top" style={{ top: newAbove }}>
                    <span className="jump-count">
                      {fresh} new message{fresh === 1 ? "" : "s"}
                      {first
                        ? ` since ${new Date(first.postedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                        : ""}
                    </span>
                    <span className="grow" />
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => {
                        const el = scroller.current;
                        const line = el?.querySelector<HTMLElement>(".new-divider");
                        if (el && line)
                          el.scrollTop = Math.max(
                            0,
                            line.getBoundingClientRect().top -
                              el.getBoundingClientRect().top +
                              el.scrollTop -
                              48,
                          );
                      }}
                    >
                      Jump{" "}
                      <Icon name="chevron-down" size={14} style={{ transform: "rotate(180deg)" }} />
                    </button>
                    <button className="btn" type="button" onClick={markAllRead}>
                      Mark as read
                    </button>
                  </div>
                );
              })()
            : null}
          <div className="messages" ref={scroller} onScroll={onScroll}>
            {unreadAbove && !(mode === "live" && paged.status === "LoadingMore") ? (
              <div className="unread-above">
                <span>Unread messages go on above.</span>
                {mode === "live" ? (
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={loadOlder}
                    disabled={paged.status !== "CanLoadMore"}
                  >
                    Load them
                  </button>
                ) : null}
              </div>
            ) : null}
            {mode === "around" && around?.hasOlder ? (
              <button
                className="btn ghost load-older"
                type="button"
                onClick={() => around.messages[0] && jumpTo(around.messages[0].messageId)}
              >
                Show older messages
              </button>
            ) : mode === "live" && paged.status === "LoadingMore" ? (
              <div className="muted load-older">Loading older messages…</div>
            ) : mode === "live" && paged.status === "Exhausted" && messages.length > 0 ? (
              <div className={`channel-start muted ${channel?.kind === "direct" ? "direct" : ""}`}>
                <span className="channel-start-title">
                  {channel?.kind === "direct" ? (
                    // A conversation opens on who it's with, large and centered, as Muse's does.
                    <span className="dm-faces">
                      {dmRuns.slice(0, 3).map((r) => (
                        <HarnessMark
                          key={r.runId}
                          harness="run"
                          size={others.length + dmRuns.length === 1 ? 64 : 40}
                          title={r.label}
                        />
                      ))}
                      {others.slice(0, Math.max(0, 3 - dmRuns.length)).map((m) => (
                        <MemberFace
                          key={m.memberId}
                          member={m}
                          members={session.members}
                          size={others.length + dmRuns.length === 1 ? 64 : 40}
                          presence={facePresence(m.memberId)}
                        />
                      ))}
                    </span>
                  ) : (
                    <Icon name={channel?.kind === "private" ? "lock" : "hash"} size={14} />
                  )}
                  {channel?.kind === "direct" ? channel.name : channel?.name}
                </span>
                {onlyAgent ? (
                  // An agent's conversation opens on what it's doing and who it answers to, as Muse's does.
                  <span className="dm-agent-line">
                    <span className={`state-${onlyAgent.state}`}>
                      {onlyAgent.state === "idle" ? "Idle" : STATE_META[onlyAgent.state].label}
                    </span>
                    {onlyAgent.line ? <span className="muted"> {onlyAgent.line}</span> : null}
                  </span>
                ) : null}
                {/* A face and a name open a conversation with a person; only an agent's limits need words. */}
                {channel?.kind === "direct" && !onlyAgentMember?.addedBy ? null : (
                  <span>
                    {channel?.kind === "direct" && onlyAgentMember?.addedBy
                      ? `An agent added by ${onlyAgentMember.addedBy.name}. It can do at most what ${onlyAgentMember.addedBy.name} can.`
                      : `This is the start of ${title}.`}
                  </span>
                )}
              </div>
            ) : null}
            {paged.status === "LoadingFirstPage" ? (
              <div className="loading-stage" role="status">
                <LinkMascot size={44} />
                <span>Loading…</span>
              </div>
            ) : null}
            {paged.status !== "LoadingFirstPage" &&
            messages.length === 0 &&
            (calls ?? []).length === 0 ? (
              <Empty>
                {channel?.kind === "direct"
                  ? "No messages yet. Say hello."
                  : "No messages yet. Say hello, or press Join call to talk."}
              </Empty>
            ) : null}
            <div className="messages-inner" ref={inner}>
              {(() => {
                // Runs and days: a message joins its author's run unless something sits between them
                // (a day change, the "new" divider, a call event, a call's proposed tasks).
                let prev: { authorId: string; at: number; plain: boolean } | undefined;
                let lastAt: number | undefined;
                // A call with nothing said between its start and end is one line, on its end.
                const whole = new Set<string>();
                items.forEach((item, i) => {
                  const next = items[i + 1];
                  if (
                    item.kind === "call" &&
                    item.event === "started" &&
                    next?.kind === "call" &&
                    next.event === "ended" &&
                    next.call.callId === item.call.callId &&
                    sameDay(item.at, next.at)
                  )
                    whole.add(item.call.callId);
                });
                // Short calls back to back, with nothing said and no notes between them, are one line on
                // the first: "Rosa Vega started 2 calls", as Grok Bot folds "6 messages with Kenny, Tyler".
                const quiet = (c: ChannelCall) =>
                  whole.has(c.callId) && c.proposals.length === 0 && !c.hasTranscript;
                const groups = new Map<string, ChannelCall[]>();
                const folded = new Set<string>();
                let head: { call: ChannelCall; at: number } | undefined;
                for (const item of items) {
                  if (
                    item.kind === "call" &&
                    item.event === "started" &&
                    whole.has(item.call.callId)
                  )
                    continue;
                  if (item.kind === "call" && item.event === "ended" && quiet(item.call)) {
                    if (head && sameDay(head.at, item.at)) {
                      groups.get(head.call.callId)!.push(item.call);
                      folded.add(item.call.callId);
                    } else {
                      head = { call: item.call, at: item.at };
                      groups.set(item.call.callId, [item.call]);
                    }
                  } else head = undefined;
                }
                return items.flatMap((item) => {
                  if (
                    item.kind === "call" &&
                    item.event === "started" &&
                    whole.has(item.call.callId)
                  )
                    return [];
                  if (item.kind === "call" && folded.has(item.call.callId)) return [];
                  const newDay = lastAt === undefined || !sameDay(lastAt, item.at);
                  lastAt = item.at;
                  const day = newDay ? (
                    <Separator className="day-sep" aria-label={dayLabel(item.at)}>
                      <span>{dayLabel(item.at)}</span>
                    </Separator>
                  ) : null;
                  if (item.kind === "call") {
                    const { call } = item;
                    prev = undefined;
                    return (
                      <div key={`${call.callId}-${item.event}`} className="tl-item">
                        {day}
                        <CallEvent
                          call={call}
                          kind={
                            item.event === "ended" && whole.has(call.callId) ? "whole" : item.event
                          }
                          more={
                            item.event === "ended" ? groups.get(call.callId)?.slice(1) : undefined
                          }
                        />
                        {item.event === "ended" && callActionsPlace(call, shownMessageIds) === "end"
                          ? proposalsFor(call)
                          : null}
                      </div>
                    );
                  }
                  const { message } = item;
                  const notes = notesOf.get(message.messageId);
                  // A run's messages are their own group, per driver (ADR 0029 D2).
                  const part = groupPart(message);
                  const newHere = divider === message.messageId;
                  const continued = !newDay && !newHere && continuesRun(prev, part);
                  prev = notes ? undefined : part;
                  return (
                    <div key={message.messageId} className={`tl-item ${continued ? "cont" : ""}`}>
                      {newHere ? <NewDivider day={newDay ? dayLabel(item.at) : undefined} /> : day}
                      <MessageItem
                        message={message}
                        nav={nav}
                        members={members}
                        everyone={everyone}
                        continued={continued}
                        dayShown
                        threadOpen={side?.kind === "replies" && side.parent === message.messageId}
                        readSeq={readSeq}
                        newReplies={newRepliesOf.get(message.messageId)}
                        highlight={highlight === message.messageId}
                        editing={editingId === message.messageId}
                        onEditingChange={(on) =>
                          on ? setEditingId(message.messageId) : stopEditing()
                        }
                        // A reply shown in the channel too opens its thread.
                        onReply={() => replyTo(message.replyTo ?? message.messageId)}
                        onJump={jumpTo}
                        onMarkUnread={
                          message.seq !== undefined ? () => markUnreadFrom(message) : undefined
                        }
                        onOpenThread={replyTo}
                        runLatest={latestRuns.has(message.messageId)}
                      />
                      {notes ? <div className="msg-indent">{proposalsFor(notes)}</div> : null}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
          {mode === "live" && (place.far || (place.off && unreadBelow > 0)) ? (
            <div className="jump-bar">
              <span className={unreadBelow > 0 ? "jump-count" : "muted"}>
                {unreadBelow > 0
                  ? `${unreadBelow} new message${unreadBelow === 1 ? "" : "s"} below`
                  : "You're looking at older messages."}
              </span>
              <span className="grow" />
              {unreadBelow > 0 ? (
                <button className="btn ghost" type="button" onClick={markAllRead}>
                  Mark as read
                </button>
              ) : null}
              <button className="btn" type="button" onClick={toNewest}>
                <span>Jump to the newest</span> <Icon name="chevron-down" size={14} />
              </button>
            </div>
          ) : null}
          {(() => {
            // At the newest, an unread reply up in a thread is why the channel still has a count: say so.
            if (mode !== "live" || place.off) return null;
            const waiting = waitingThreads;
            const first = waiting[0];
            if (!first) return null;
            const n = first.newReplies;
            return (
              <div className="jump-bar">
                <span className="jump-count">
                  {waiting.length > 1
                    ? `New replies in ${waiting.length}${unreadThreads.complete ? "" : "+"} threads`
                    : `${n}${first.moreNew ? "+" : ""} new repl${n === 1 && !first.moreNew ? "y" : "ies"} in a thread from ${first.message.author.name}`}
                </span>
                <span className="grow" />
                <button
                  className="btn"
                  type="button"
                  onClick={() => replyTo(first.message.messageId)}
                >
                  <Icon name="reply" size={14} />{" "}
                  {waiting.length > 1 ? "Open the newest" : "Open the thread"}
                </button>
              </div>
            );
          })()}
          {mode === "around" ? (
            <div className="jump-bar">
              <span className="muted">You're looking at older messages.</span>
              <button className="btn" type="button" onClick={backToPresent}>
                Jump to the newest
              </button>
            </div>
          ) : null}
          {channel ? (
            <Composer
              ref={composer}
              channelId={channelId}
              members={members}
              everyone={everyone}
              placeholder={`Message ${title}`}
              notes={dmWarnings}
              {...(dmFileNote ? { fileNote: dmFileNote } : {})}
              onEditLast={editLast}
              onEscape={readAll}
              // Posting marks the channel read in the room, so read marks follow what's on screen again.
              onSent={() => setHoldRead(false)}
            />
          ) : null}
        </div>
        {browser === "closed" && side?.kind === "replies" && parent ? (
          <Replies
            key={parent.messageId}
            where={title}
            parent={parent}
            readSeq={readSeq}
            me={me}
            nav={nav}
            members={members}
            highlight={side.highlight}
            onPositioned={() =>
              setSide((s) => (s?.kind === "replies" ? { kind: "replies", parent: s.parent } : s))
            }
            scroller={repliesScroller}
            onShown={maybeMarkRead}
            onBack={searchSpec ? () => setSide({ kind: "search", spec: searchSpec }) : undefined}
            notes={dmWarnings}
            waiting={!channel}
            onSent={() => setHoldRead(false)}
            onClose={() => setSide(null)}
          />
        ) : browser === "closed" && side?.kind === "transcript" ? (
          <TranscriptPanel callId={side.callId} onClose={() => setSide(null)} />
        ) : browser === "closed" && side?.kind === "pins" ? (
          <PinnedPanel
            channelId={channelId}
            title={title}
            nav={nav}
            members={members}
            onJump={jumpTo}
            onClose={() => setSide(null)}
          />
        ) : browser === "closed" && side?.kind === "search" ? (
          <SearchPanel
            spec={side.spec}
            current={focus}
            nav={nav}
            onChange={(spec) => {
              setSearchSpec(spec);
              setSide({ kind: "search", spec });
            }}
            onClose={() => setSide(null)}
            onOpen={(r) => {
              // The result already open here: the route wouldn't change, so nothing would move.
              // Open it again directly: its thread beside it if it's a reply, and the list at it.
              if (r.channelId === channelId && r.messageId === focus) {
                setTarget(r.messageId);
                if (r.replyTo)
                  setSide({ kind: "replies", parent: r.replyTo, highlight: r.messageId });
                return;
              }
              nav.go({
                name: "channel",
                channelId: r.channelId,
                messageId: r.messageId,
                search: side.spec,
              });
            }}
          />
        ) : showPeople ? (
          <PeoplePanel channel={channel} nav={nav} onClose={() => setPeopleOpen(false)} />
        ) : null}
        {browser !== "closed" ? (
          <BrowserDock
            channelId={channelId}
            channelName={channel?.name ?? "channel"}
            size={browser}
            onToggleSize={() => setBrowser((b) => (b === "full" ? "side" : "full"))}
            onClose={() => setBrowser("closed")}
          />
        ) : null}
      </div>
    </MessageRows.Provider>
  );
}

/** The channel's menu: how much it tells you about (spec #63), and marking it read. */
function ChannelMenu({
  channel,
  onMarkRead,
}: {
  channel: ChannelRow | undefined;
  /** The view's own Mark as read: it also lets read marks follow what's on screen again after Mark unread. */
  onMarkRead: () => void;
}) {
  const setNotify = useAct(api.channels.setNotify);
  if (!channel) return null;
  const levels = [
    { level: "all", label: "All messages" },
    { level: "mentions", label: "Mentions and replies" },
    { level: "none", label: "Nothing" },
  ] as const;
  return (
    <Menu>
      <Tip label="Notifications for this channel">
        <MenuTrigger className="btn icon" aria-label="Notifications for this channel">
          <Icon name="bell" />
        </MenuTrigger>
      </Tip>
      <MenuContent
        className="pop channel-menu"
        side="bottom"
        align="end"
        sideOffset={4}
        style={{ minWidth: 240 }}
      >
        <MenuRadioGroup
          value={channel.notify ?? null}
          onValueChange={(level) =>
            void setNotify({
              channelId: channel.channelId,
              level: level as (typeof levels)[number]["level"],
            })
          }
        >
          <MenuGroupLabel className="pop-title">Tell me about</MenuGroupLabel>
          {levels.map(({ level, label }) => (
            <MenuRadioItem key={level} value={level} closeOnSelect>
              <span className="grow">{label}</span>
              <MenuItemIndicator>
                <Icon name="check" />
              </MenuItemIndicator>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        {/* Unavailable with nothing unread; the reason shows on the item itself. */}
        <MenuItem disabled={channel.unread === 0} label="Mark as read" onSelect={onMarkRead}>
          <span className="grow">Mark as read</span>
          {channel.unread === 0 ? (
            <span className="channel-menu-reason">All messages read</span>
          ) : null}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function Replies({
  where,
  parent,
  readSeq,
  me,
  nav,
  members,
  highlight,
  onPositioned,
  scroller,
  onShown,
  onBack,
  notes,
  waiting,
  onSent,
  onClose,
}: {
  /** The channel's name as its header shows it, so the panel says where the thread is. */
  where: string;
  parent: MessageRow;
  /** Where you had read the channel up to: the thread opens at the first reply past it. */
  readSeq: number;
  me: string;
  nav: Nav;
  members: MentionMember[];
  /** The reply this navigation opened at (from search or a banner), until it has been shown. */
  highlight?: Id<"messages"> | undefined;
  /** Called once the panel has scrolled to `highlight`, to clear it. */
  onPositioned: () => void;
  /** The panel's scrolling list, which the channel's read tracking looks at too. */
  scroller: React.RefObject<HTMLDivElement | null>;
  /** Called when what the panel shows may have changed: replies loaded or scrolled. */
  onShown: () => void;
  /** Back to the search results this thread was opened from. */
  onBack?: (() => void) | undefined;
  /** The direct message's warnings, shown above the reply box too: a reply reaches its runs as well (ADR 0039). */
  notes: readonly string[];
  /** The channel's details haven't loaded, so its warnings aren't known yet: replies wait to send. */
  waiting: boolean;
  /** After a reply from the panel's composer went out. */
  onSent: () => void;
  onClose: () => void;
}) {
  const replies = useRoomQuery(api.messages.replies, { messageId: parent.messageId });
  const latestReplies = useMemo(
    () => latestOfRuns([parent, ...(replies ?? [])]),
    [parent, replies],
  );
  // Where you had read up to when the thread opened: the "new" divider stays there.
  const [readAtOpen] = useState(readSeq);
  const firstNew = replies ? firstUnreadReply(replies, readAtOpen, me) : null;
  // The reply it opened at flashes for a moment, as a jump in the channel does.
  const [flash, setFlash] = useState<Id<"messages"> | null>(null);
  // Opens once per thread (the panel is keyed by its parent): at the reply a navigation names, else
  // at the first reply you haven't read, else at the newest. Read marks then follow what's on screen.
  useOpenPlace(
    highlight,
    replies !== undefined,
    (id) => {
      scroller.current
        ?.querySelector(`[data-message="${id}"]`)
        ?.scrollIntoView({ block: "center" });
      setFlash(id);
      if (scroller.current) measureEnd(scroller.current);
    },
    onPositioned,
    () => {
      const el = scroller.current;
      if (!el) return;
      const row = firstNew ? el.querySelector<HTMLElement>(`[data-message="${firstNew}"]`) : null;
      if (row) el.scrollTop = Math.max(0, row.offsetTop - el.offsetTop - 40);
      // A short thread opens at its first message, so you see what it's about; a long one at the newest.
      else el.scrollTop = el.scrollHeight <= el.clientHeight * 2 ? 0 : el.scrollHeight;
      measureEnd(el);
    },
  );
  // A new reply while you're at the end of the thread comes into view, as in the channel; the first
  // load never moves it from where it opened (a reply from a link or search, or the first unread).
  const measureEnd = useFollowNew(scroller, replies?.length);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(timer);
  }, [flash]);
  // Read tracking, apart from positioning: whenever the replies change.
  useEffect(() => {
    if (replies) onShown();
  }, [replies, onShown]);
  return (
    <aside className="channel-col side-panel replies-panel" aria-label="Replies">
      <header className="main-head">
        {onBack ? (
          <Tip label="Back to the search results">
            <button
              className="btn icon"
              type="button"
              aria-label="Back to the search results"
              onClick={onBack}
            >
              <Icon name="chevron-left" />
            </button>
          </Tip>
        ) : null}
        <h1 className="truncate">
          Thread <span className="head-where">in {where}</span>
        </h1>
        <span className="grow" />
        <Tip label="Close replies">
          <button className="btn icon" type="button" aria-label="Close replies" onClick={onClose}>
            <Icon name="close" />
          </button>
        </Tip>
      </header>
      {/* data-loaded: read tracking takes the panel as the whole thread only once its replies came. */}
      <div
        className="messages"
        ref={scroller}
        onScroll={(event) => {
          measureEnd(event.currentTarget);
          onShown();
        }}
        data-loaded={replies !== undefined}
      >
        <MessageItem
          message={parent}
          nav={nav}
          members={members}
          everyone
          inReplies
          runLatest={latestReplies.has(parent.messageId)}
        />
        <div className="section-head" style={{ padding: "4px 0" }}>
          {replies?.length ?? 0} repl{replies?.length === 1 ? "y" : "ies"}
        </div>
        {(replies ?? []).map((reply, i, all) => {
          // Day separators as in the channel, so each reply shows only its time.
          const newDay = i === 0 || !sameDay(all[i - 1]!.postedAt, reply.postedAt);
          const isNew = reply.messageId === firstNew;
          return (
            <div key={reply.messageId}>
              {isNew ? (
                <NewDivider day={newDay ? dayLabel(reply.postedAt) : undefined} />
              ) : newDay ? (
                <Separator className="day-sep" aria-label={dayLabel(reply.postedAt)}>
                  <span>{dayLabel(reply.postedAt)}</span>
                </Separator>
              ) : null}
              <MessageItem
                message={reply}
                nav={nav}
                members={members}
                everyone
                inReplies
                dayShown
                highlight={reply.messageId === flash}
                runLatest={latestReplies.has(reply.messageId)}
              />
            </div>
          );
        })}
      </div>
      {parent.deletedAt === undefined ? (
        <Composer
          channelId={parent.channelId}
          replyTo={parent.messageId}
          compact
          members={members}
          everyone
          alsoSendTo={where}
          notes={notes}
          waiting={waiting}
          onSent={onSent}
        />
      ) : null}
    </aside>
  );
}

/** A channel's pinned messages, newest pin first (spec #63). */
function PinnedPanel({
  channelId,
  title,
  nav,
  members,
  onJump,
  onClose,
}: {
  channelId: Id<"channels">;
  title: string;
  nav: Nav;
  members: MentionMember[];
  onJump: (messageId: Id<"messages">) => void;
  onClose: () => void;
}) {
  const pins = useRoomQuery(api.channels.pins, { channelId });
  return (
    <aside className="channel-col side-panel pinned-panel" aria-label="Pinned messages">
      <header className="main-head">
        <h1>
          <Icon className="head-glyph" name="pushpin" />
          Pinned
          {pins?.length ? <span className="head-count">{pins.length}</span> : null}
        </h1>
        <span className="grow" />
        <Tip label="Close pinned messages">
          <button
            className="btn icon"
            type="button"
            aria-label="Close pinned messages"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </Tip>
      </header>
      <div className="messages">
        {pins !== undefined && pins.length === 0 ? (
          <Empty>Nothing is pinned in {title}. Pin a message from its actions.</Empty>
        ) : null}
        {(pins ?? []).map((message) => (
          <div key={message.messageId} className="pinned-item">
            <MessageItem message={message} nav={nav} members={members} everyone inReplies inPins />
            <div className="msg-indent row-flex">
              <span className="muted">Pinned by {message.pinned?.by.name}</span>
              <span className="grow" />
              <button className="btn" type="button" onClick={() => onJump(message.messageId)}>
                Jump to it
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** A search's results beside the channel a result opened in (Discord's search panel), with its filters as chips. */
function SearchPanel({
  spec,
  current,
  nav,
  onChange,
  onClose,
  onOpen,
}: {
  spec: SearchSpec;
  current?: string | undefined;
  nav: Nav;
  onChange: (spec: SearchSpec) => void;
  onClose: () => void;
  /** Opens a result: the channel at it, with these results beside it. */
  onOpen: (result: SearchResult) => void;
}) {
  const session = useSession();
  const channels = useRoomQuery(api.channels.list, {});
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const key = JSON.stringify(spec);
  useEffect(() => setCursors([null]), [key]);
  const names = useMemo(
    () => new Map(session.members.map((m) => [m.memberId as string, m.name])),
    [session.members],
  );
  const day = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const where = channels?.find((c) => c.channelId === spec.channelId);
  const chips: { label: string; drop: keyof SearchSpec }[] = [
    ...(spec.channelId
      ? [{ label: `In ${where ? channelTitle(where) : "a channel"}`, drop: "channelId" as const }]
      : []),
    ...(spec.authorId
      ? [{ label: `From ${names.get(spec.authorId) ?? "someone"}`, drop: "authorId" as const }]
      : []),
    ...(spec.from !== undefined
      ? [{ label: `Since ${day(spec.from)}`, drop: "from" as const }]
      : []),
    ...(spec.to !== undefined ? [{ label: `Until ${day(spec.to)}`, drop: "to" as const }] : []),
    ...(spec.has
      ? [
          {
            label: spec.has === "attachment" ? "With attachments" : "With links",
            drop: "has" as const,
          },
        ]
      : []),
  ];
  const without = (drop: keyof SearchSpec): SearchSpec => {
    const next = { ...spec };
    delete next[drop];
    return next;
  };
  return (
    <aside className="channel-col side-panel search-panel" aria-label="Search results">
      <header className="main-head">
        <h1 className="truncate">
          <Icon className="head-glyph" name="search" />
          <span className="truncate">“{spec.query}”</span>
        </h1>
        <span className="grow" />
        <Tip label="Close search results">
          <button
            className="btn icon"
            type="button"
            aria-label="Close search results"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </Tip>
      </header>
      <div className="search-panel-bar">
        {chips.map((chip) => (
          <span key={chip.drop} className="filter-chip">
            <span className="truncate">{chip.label}</span>
            <button
              className="icon-btn"
              type="button"
              aria-label={`Remove the filter: ${chip.label}`}
              onClick={() => onChange(without(chip.drop))}
            >
              <Icon name="close" size={14} />
            </button>
          </span>
        ))}
        <span className="grow" />
        <SegmentedControl
          className="seg"
          aria-label="Order"
          value={spec.sort === "newest" ? "newest" : "relevance"}
          onValueChange={(sort) =>
            onChange(sort === "newest" ? { ...spec, sort: "newest" } : without("sort"))
          }
        >
          <SegmentedControlItem value="relevance">Best match</SegmentedControlItem>
          <SegmentedControlItem value="newest">Newest</SegmentedControlItem>
        </SegmentedControl>
      </div>
      <div className="messages search-results">
        {cursors.map((cursor, i) => (
          <ResultPage
            key={`${key}-${i}-${cursor}`}
            args={{ ...spec, cursor }}
            names={names}
            compact
            current={current}
            first={i === 0}
            last={i === cursors.length - 1}
            onMore={(next) => setCursors((all) => [...all, next])}
            onOpen={onOpen}
          />
        ))}
      </div>
      <footer className="search-panel-foot">
        <button
          className="btn ghost"
          type="button"
          onClick={() => nav.go({ name: "search", query: spec.query })}
        >
          Open in Search to change filters
        </button>
      </footer>
    </aside>
  );
}

/**
 * What the composer says about files once some are attached, in a direct message with runs that
 * don't take files with a message (ADR 0043): a terminal's harness gets copies saved in its workspace,
 * and a run whose bridge is older hears only that files are attached.
 */
export function filesNote(
  runs: { label: string; files?: "with_message" | "saved" | "stay" }[],
): string | undefined {
  const list = (labels: string[]) =>
    labels.length < 3
      ? labels.join(" and ")
      : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  const saved = runs.filter((r) => r.files === "saved").map((r) => r.label);
  const stay = runs.filter((r) => r.files === "stay").map((r) => r.label);
  const lines = [
    saved.length
      ? `${list(saved)} ${saved.length === 1 ? "takes" : "take"} no files with a message, so ${saved.length === 1 ? "it gets" : "they get"} copies saved in ${saved.length === 1 ? "its" : "their"} workspace, in .uplink-room/files, with the paths in the message.`
      : "",
    stay.length
      ? `${list(stay)} only ${stay.length === 1 ? "hears" : "hear"} that files are attached: they stay in the room.`
      : "",
  ].filter(Boolean);
  return lines.length ? lines.join(" ") : undefined;
}
