/**
 * Pairs in the app (ADR 0027, ADR 0034, slice 12 of #139): the person's Pairs in the sidebar, a
 * Pair's conversation, and making and using pair codes. A Pair is outside every team, so nothing
 * here reads the team session: the same views serve a person with a team and one with none.
 *
 * A Pair reads like a direct message (DESIGN.md, Conversations): bubbles, your own on the right, and
 * it opens on who it's with. Each side sees only names, pictures and run labels (D12). Its messages
 * carry images and files as a direct message's do (ADR 0048), each through a short-lived link.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePaginatedQuery } from "convex/react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { Textarea } from "@ui-sdk/react/textarea";
import { Covered } from "../lib/covered";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import {
  codeTimeLeft,
  joinOutcome,
  notDeliveredLine,
  pairEndedLine,
  pairTitle,
  readCode,
  useAccountAct,
  useSoftAccountQuery,
  type PairCode,
  type PairMessage,
  type PairView as Pair,
} from "../lib/pairs";
import { Face, HarnessMark } from "../components/Faces";
import { Icon } from "../components/Icon";
import { Cmd } from "../components/Cmd";
import { CopyButton } from "../components/Copy";
import { MessageBody } from "../components/MessageBody";
import { useNow } from "../components/useNow";
import { Tip } from "../components/Tip";
import { Attachments } from "../components/chat/Attachments";
import {
  fileDrop,
  PendingFileChips,
  PendingFileErrors,
  useUploads,
} from "../components/chat/FileUploads";
import { LinkMascot } from "../characters/LinkMascot";
import "./pairs.css";

type Person = Pair["people"][number];

const isYou = (p: { you?: true | undefined } | object): boolean => "you" in p && p.you === true;

/** The other people in a Pair, or you alone while nobody has joined. */
function othersOf(pair: Pair): Person[] {
  const others = pair.people.filter((p) => !isYou(p));
  return others.length ? others : pair.people;
}

function PersonFace({
  person,
  size,
}: {
  person: { name: string; avatarUrl?: string | undefined };
  size: number;
}) {
  return (
    <span className="conversation-face" data-size={size}>
      <Face who={{ name: person.name, kind: "person", avatarUrl: person.avatarUrl }} />
    </span>
  );
}

/** How many Pairs each page of the list holds. */
const PAIRS_PAGE = 50;

/**
 * Your Pairs, live and ended, latest activity first (`pairs` undefined while loading), and `more`
 * while there are more pages. The room pages them by when you joined, so a page is sorted here.
 */
export type PairList = { pairs: Pair[] | undefined; more: (() => void) | undefined };

export function usePairs(): PairList {
  const paged = usePaginatedQuery(api.pairs.listPage, {}, { initialNumItems: PAIRS_PAGE });
  const loading = paged.status === "LoadingFirstPage";
  const pairs = useMemo(
    () =>
      loading
        ? undefined
        : [...paged.results].sort(
            (a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt),
          ),
    [loading, paged.results],
  );
  const { loadMore } = paged;
  const more = useMemo(
    () => (paged.status === "CanLoadMore" ? () => loadMore(PAIRS_PAGE) : undefined),
    [paged.status, loadMore],
  );
  return { pairs, more };
}

/** The last row of a list of Pairs while it has more pages. */
function MorePairs({ more, className }: { more: (() => void) | undefined; className: string }) {
  if (!more) return null;
  return (
    <button className={className} type="button" onClick={more}>
      <Icon name="chevron-down" />
      <span className="label-text">More Pairs</span>
    </button>
  );
}

// ---------- the sidebar ----------

/**
 * The sidebar's Pairs: each with who else is in it and its unread count, a + to start or join one,
 * and with none, one row that does the same, as the Roster's "Add your first agent" does.
 */
export function PairsNav({
  bare,
  pairs,
  more,
  currentPairId,
  onOpen,
  onStart,
}: {
  /** In a list shared with other conversations: no heading of its own and no empty row. */
  bare?: boolean;
  pairs: Pair[] | undefined;
  /** Loads the next page of Pairs, while there is one. */
  more?: (() => void) | undefined;
  currentPairId: string | undefined;
  onOpen: (pairId: string) => void;
  /** Opens the popover to start a Pair or join one with a code, under the button clicked. */
  onStart: (anchor: DOMRect) => void;
}) {
  return (
    <>
      {bare ? null : (
        <div className="nav-heading pairs-heading">
          <span className="grow">Pairs</span>
          <Tip label="Start or join a Pair">
            <button
              className="icon-btn"
              type="button"
              aria-label="Start or join a Pair"
              onClick={(event) => onStart(event.currentTarget.getBoundingClientRect())}
            >
              <Icon name="plus" />
            </button>
          </Tip>
        </div>
      )}
      {pairs === undefined ? null : pairs.length === 0 ? (
        bare ? null : (
          <button
            className="nav-item roster-empty"
            type="button"
            onClick={(event) => onStart(event.currentTarget.getBoundingClientRect())}
          >
            <Icon name="link" />
            <span className="label-text">Pair with someone's run</span>
          </button>
        )
      ) : (
        pairs.map((pair) => {
          const others = othersOf(pair);
          const ended = pair.endedAt !== undefined;
          return (
            <Tip
              key={pair.pairId}
              label={ended ? `${pairTitle(pair)}, ended` : pairTitle(pair)}
              side="right"
            >
              <button
                className={`nav-item dm-item pair-item ${pair.unread > 0 && !ended ? "unread" : ""} ${ended ? "ended" : ""}`}
                type="button"
                aria-current={currentPairId === pair.pairId ? "page" : undefined}
                onClick={() => onOpen(pair.pairId)}
              >
                <PersonFace person={others[0]!} size={32} />
                <span className="label-text">{pairTitle(pair)}</span>
                {ended ? <span className="sr-only">, ended</span> : null}
                {pair.unread > 0 && !ended ? (
                  <span className="sr-only">, {pair.unread} unread</span>
                ) : null}
              </button>
            </Tip>
          );
        })
      )}
      <MorePairs more={more} className="nav-item more-pairs" />
    </>
  );
}

// ---------- starting and joining ----------

/**
 * Start a Pair, or join one with a code someone passed on. A popover by the + that opened it: both
 * are quick, and nothing is lost by clicking away. A new Pair opens with its first code showing.
 */
export function PairStart({
  anchor,
  onClose,
  onOpened,
  initialJoin,
}: {
  anchor: DOMRect;
  onClose: () => void;
  /** A Pair to open: `code` when it was just made and its first code should show. */
  onOpened: (pairId: string, opts: { code: boolean }) => void;
  /** The gym opens it on the join form, with a code typed and the room's answer to it. */
  initialJoin?: { code: string; error?: string } | undefined;
}) {
  const [mode, setMode] = useState<"menu" | "join">(initialJoin ? "join" : "menu");
  const create = useAccountAct(api.pairs.create);
  const close = useRef(onClose);
  close.current = onClose;

  return (
    // Open while it's rendered, like components/Dialog.tsx: the caller unmounts it in onClose.
    <Popover
      open
      onOpenChange={(open, details) => {
        if (open) return;
        details.cancel();
        close.current();
      }}
    >
      <PopoverContent
        className="pop pair-start"
        aria-label="Start or join a Pair"
        anchor={{ getBoundingClientRect: () => anchor }}
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={8}
      >
        {mode === "menu" ? (
          <>
            <div className="pop-title">Pairs</div>
            <p className="pair-start-intro muted">
              Talk with someone's Claude Code or Codex session, in any team or none. Each side sees
              only the Pair.
            </p>
            <Button
              onClick={async () => {
                const made = await create({});
                if (made && typeof made === "object") onOpened(made.pairId, { code: true });
              }}
            >
              <Icon name="plus" />
              <span className="grow">New Pair</span>
            </Button>
            <button type="button" onClick={() => setMode("join")}>
              <Icon name="link" />
              <span className="grow">Join with a code</span>
            </button>
          </>
        ) : (
          <JoinWithCode
            initial={initialJoin}
            onJoined={(pairId) => onOpened(pairId, { code: false })}
            onBack={() => setMode("menu")}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function JoinWithCode({
  initial,
  onJoined,
  onBack,
}: {
  initial?: { code: string; error?: string } | undefined;
  onJoined: (pairId: string) => void;
  onBack: () => void;
}) {
  const join = useAccountAct(api.pairs.join);
  const [code, setCode] = useState(initial?.code ?? "");
  const [error, setError] = useState<string | undefined>(initial?.error);
  // One join at a time, whether Join was pressed or the form was submitted another way.
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const typed = readCode(code);
  const submit = async () => {
    if (!typed || busy.current) return;
    busy.current = true;
    try {
      const result = await join({ code: typed });
      if (!result || typeof result !== "object") return;
      const outcome = joinOutcome(result as Parameters<typeof joinOutcome>[0]);
      if ("error" in outcome) setError(outcome.error);
      else onJoined(outcome.pairId);
    } finally {
      busy.current = false;
    }
  };
  // A pair code is two words of any length and two numbers, so it's one text field, not OTP slots.
  return (
    <form
      className="pair-join"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="pop-title">Join with a code</div>
      <Field invalid={error ? true : undefined}>
        <FieldLabel className="sr-only">Pair code</FieldLabel>
        <Input
          ref={input}
          id="pair-code-input"
          className="input"
          placeholder="RIVER-4821-MAPLE-0937"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onValueChange={(next) => {
            setCode(next);
            setError(undefined);
          }}
        />
        {error ? (
          <FieldError match className="pair-join-error">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </FieldError>
        ) : (
          <FieldDescription className="hint">
            The code someone made in a Pair. It works once, for 10 minutes.
          </FieldDescription>
        )}
      </Field>
      <div className="row-flex">
        <button className="btn ghost" type="button" onClick={onBack}>
          Back
        </button>
        <span className="grow" />
        <Button
          className="btn primary"
          type="submit"
          disabled={!typed}
          onClick={(event) => {
            // Join runs here, so the button shows it's busy; the form isn't submitted as well.
            event.preventDefault();
            return submit();
          }}
        >
          Join
        </Button>
      </div>
    </form>
  );
}

// ---------- the landing page ----------

/**
 * Pairs as a page: the home of someone in no team, and where an empty list leads. It says what a
 * Pair is once, offers both ways in, and lists the Pairs there are.
 */
export function PairsLanding({
  pairs,
  more,
  onOpen,
  onStart,
  children,
}: {
  pairs: Pair[] | undefined;
  /** Loads the next page of Pairs, while there is one. */
  more?: (() => void) | undefined;
  onOpen: (pairId: string) => void;
  onStart: (anchor: DOMRect) => void;
  /** More of the page below the Pairs, such as making or joining a team. */
  children?: ReactNode;
}) {
  return (
    <>
      <header className="main-head">
        <h1>
          <Icon className="head-glyph" name="link" />
          Pairs
        </h1>
      </header>
      <div className="main-body pairs-landing">
        <section className="pairs-intro" aria-labelledby="pairs-intro-title">
          <LinkMascot size={44} />
          <div>
            <h2 id="pairs-intro-title">{pairs && pairs.length ? "Your Pairs" : "No Pairs yet"}</h2>
            <p className="muted">
              A Pair is a private conversation between your Claude Code or Codex sessions and
              someone else's, in any team or none. Make a code here and pass it on, or join with one
              someone gave you. Each side sees names, pictures and run labels, never an email or a
              team.
            </p>
            <div className="row-flex">
              <button
                className="btn primary"
                type="button"
                onClick={(event) => onStart(event.currentTarget.getBoundingClientRect())}
              >
                <Icon name="link" /> Start or join a Pair
              </button>
            </div>
            <p className="hint">
              In a session, <Cmd text="uplink pair" /> makes a code and{" "}
              <Cmd text="uplink pair RIVER-4821-MAPLE-0937" /> joins with one.
            </p>
          </div>
        </section>
        {pairs && pairs.length ? (
          <ul className="pairs-rows" aria-label="Your Pairs">
            {pairs.map((pair) => (
              <li key={pair.pairId}>
                <button type="button" className="pairs-row" onClick={() => onOpen(pair.pairId)}>
                  <PersonFace person={othersOf(pair)[0]!} size={28} />
                  <span className="grow pairs-row-text">
                    <b className="truncate">{pairTitle(pair)}</b>
                    <span className="muted truncate">{rowLine(pair)}</span>
                  </span>
                  {pair.unread > 0 && pair.endedAt === undefined ? (
                    <span className="badge">{pair.unread}</span>
                  ) : null}
                </button>
              </li>
            ))}
            {more ? (
              <li>
                <MorePairs more={more} className="pairs-row more-pairs" />
              </li>
            ) : null}
          </ul>
        ) : null}
        {children}
      </div>
    </>
  );
}

function rowLine(pair: Pair): string {
  if (pair.endedAt !== undefined) return "Ended";
  if (pair.runs.length === 0) return "No run in it right now";
  return pair.runs.length === 1
    ? `${pair.runs[0]!.label} is in it`
    : `${pair.runs.length} runs in it`;
}

// ---------- a Pair ----------

/**
 * One Pair: who is in it and which runs are live, its messages, and a box to write in. Its header
 * makes a pair code (shown once), and its people button lists everyone and holds Leave and End.
 */
export function PairConversation({
  pairId,
  onLeft,
  showCode = false,
  initialMissed,
}: {
  pairId: string;
  /** You left it: it is gone for you. */
  onLeft: () => void;
  /** Open with a fresh code showing, as a Pair just made does. */
  showCode?: boolean;
  /** The gym opens it as if the last message sent hadn't reached these runs. */
  initialMissed?: string[] | undefined;
}) {
  const [leaving, setLeaving] = useState(false);
  // Read on its own, not from the sidebar's list, which may not have reached it yet. Null once
  // you aren't in it (left, or never were): pairs.get answers not_found for both.
  const pair = useSoftAccountQuery(api.pairs.get, leaving ? "skip" : { pairId });
  // Newest first from the room, a page at a time; shown oldest first.
  const paged = usePaginatedQuery(api.pairs.messagesPage, pair && !leaving ? { pairId } : "skip", {
    initialNumItems: MESSAGES_PAGE,
  });
  const messages = useMemo(
    () => (paged.status === "LoadingFirstPage" ? undefined : [...paged.results].reverse()),
    [paged.status, paged.results],
  );
  const { loadMore } = paged;
  const canLoadOlder = paged.status === "CanLoadMore";
  const loadOlder = useCallback(() => {
    if (canLoadOlder) loadMore(MESSAGES_PAGE);
  }, [canLoadOlder, loadMore]);
  const markRead = useAccountAct(api.pairs.markRead);
  const [codeOpen, setCodeOpen] = useState(showCode);

  // Reading it marks it read, as a channel on screen does, but only through what it loaded: the
  // room keeps one read mark, so it moves only once the loaded messages reach back to it.
  const readSeq = pair ? pair.seq - pair.unread : 0;
  const newest = messages?.at(-1)?.seq ?? 0;
  const oldest = messages?.[0]?.seq ?? 0;
  const reachesRead = paged.status === "Exhausted" || oldest <= readSeq + 1;
  const unreadAbove = messages !== undefined && !reachesRead;
  // Under Settings the Pair stays mounted but unseen: nothing in it is marked read until it's back.
  const covered = useContext(Covered);
  useEffect(() => {
    if (!leaving && !covered && newest > readSeq && reachesRead)
      void markRead({ pairId, seq: newest });
  }, [newest, readSeq, reachesRead, pairId, leaving, covered, markRead]);
  // Load older pages until where you had read up to is loaded, up to AUTO_UNREAD messages.
  const loaded = messages?.length ?? 0;
  useEffect(() => {
    if (unreadAbove && loaded < AUTO_UNREAD) loadOlder();
  }, [unreadAbove, loaded, loadOlder]);

  if (pair === null) {
    return (
      <>
        <header className="main-head">
          <h1>Pair</h1>
        </header>
        <div className="main-body">
          <p className="muted pair-gone">You aren't in this Pair any more.</p>
        </div>
      </>
    );
  }
  if (!pair) {
    return (
      <header className="main-head">
        <h1 className="head-loading muted">Loading…</h1>
      </header>
    );
  }

  const ended = pairEndedLine(pair);
  const others = othersOf(pair);
  const title = pairTitle(pair);
  return (
    <div className="channel-col pair-view">
      <header className="main-head">
        <span className="dm-faces">
          {others.slice(0, 3).map((p) => (
            <PersonFace key={p.id} person={p} size={24} />
          ))}
        </span>
        <h1 className="truncate">
          <span className="sr-only">Pair with </span>
          {title}
        </h1>
        <span className="head-presence muted">{ended ? "Ended" : liveLine(pair)}</span>
        <span className="grow" />
        {ended ? null : (
          <div className="pair-code-wrap">
            <Popover open={codeOpen} onOpenChange={setCodeOpen}>
              <PopoverTrigger className="btn">
                <Icon name="link" /> Make a code
              </PopoverTrigger>
              <PairCodePop pairId={pairId} />
            </Popover>
          </div>
        )}
        <PairPeople
          pair={pair}
          title={title}
          onLeaving={() => setLeaving(true)}
          onLeft={onLeft}
          onStay={() => setLeaving(false)}
        />
      </header>
      <PairMessages
        pair={pair}
        messages={messages}
        older={paged.status === "LoadingMore" ? "loading" : canLoadOlder ? "more" : "none"}
        unreadAbove={unreadAbove}
        onOlder={loadOlder}
      />
      {ended ? (
        <div className="composer">
          <p className="pair-ended muted">{ended}</p>
        </div>
      ) : (
        <PairComposer pairId={pairId} title={title} initialMissed={initialMissed} />
      )}
    </div>
  );
}

function liveLine(pair: Pair): string {
  if (pair.runs.length === 0) return "No run in it right now";
  return pair.runs.length === 1 ? "1 run live" : `${pair.runs.length} runs live`;
}

/** How many messages a page of a Pair holds. */
const MESSAGES_PAGE = 50;
/** How many messages a Pair loads on its own to reach where you had read up to, as a channel does. */
const AUTO_UNREAD = 400;

/**
 * A Pair's messages: its start once the first message is loaded, then bubbles, your own on the
 * right. Older pages load as you scroll up, or with the button at the top.
 */
function PairMessages({
  pair,
  messages,
  older,
  unreadAbove,
  onOlder,
}: {
  pair: Pair;
  messages: PairMessage[] | undefined;
  /** Whether there are older messages to load, or they are loading. */
  older: "more" | "loading" | "none";
  /** Unread messages are older than what's loaded. */
  unreadAbove: boolean;
  onOlder: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const me = pair.people.find(isYou)?.id;
  const newest = messages?.at(-1)?.messageId;
  const oldest = messages?.[0]?.messageId;
  const atBottom = useRef(true);
  const heightBeforeOlder = useRef<number | null>(null);
  // A conversation sits at the bottom and follows what's new, while you're at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [newest]);
  // Older messages loading above keep the view where it was.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || heightBeforeOlder.current === null) return;
    el.scrollTop += el.scrollHeight - heightBeforeOlder.current;
    heightBeforeOlder.current = null;
  }, [oldest]);
  const loadOlder = () => {
    if (older !== "more") return;
    heightBeforeOlder.current = scroller.current?.scrollHeight ?? null;
    onOlder();
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Ask for the older page while a screenful and a half is still above, so scrolling up doesn't stall at the top.
    if (el.scrollTop < el.clientHeight * 1.5) loadOlder();
  };
  const others = othersOf(pair);
  const big = others.length === 1 ? 64 : 40;
  return (
    <div className="messages" ref={scroller} onScroll={onScroll}>
      {older === "loading" ? (
        <div className="muted load-older">Loading older messages…</div>
      ) : older === "more" && unreadAbove ? (
        <div className="unread-above">
          <span>Unread messages go on above.</span>
          <button className="btn ghost" type="button" onClick={loadOlder}>
            Load them
          </button>
        </div>
      ) : older === "more" ? (
        <button className="btn ghost load-older" type="button" onClick={loadOlder}>
          Show older messages
        </button>
      ) : (
        <div className="channel-start muted direct pair-start-hero">
          <span className="channel-start-title">
            <span className="dm-faces">
              {others.slice(0, 3).map((p) => (
                <PersonFace key={p.id} person={p} size={big} />
              ))}
            </span>
            {pairTitle(pair)}
          </span>
          {pair.runs.length > 0 && pair.endedAt === undefined ? (
            <span className="pair-live-runs">
              {pair.runs.map((run) => (
                <span key={run.id} className="pair-live-run">
                  <HarnessMark harness={run.harness} state="working" size={20} />
                  {run.label}
                </span>
              ))}
            </span>
          ) : null}
          <span>
            Each side of this Pair sees only it: names, pictures and run labels, never an email or a
            team.
          </span>
        </div>
      )}
      {messages === undefined ? (
        <div className="loading-stage" role="status">
          <LinkMascot size={44} />
          <span>Loading…</span>
        </div>
      ) : messages.length === 0 ? (
        <p className="muted pair-quiet">
          No messages yet. What a run or person writes here reaches every run in the Pair.
        </p>
      ) : null}
      <div className="messages-inner">
        {(messages ?? []).map((message, index) => {
          const prev = messages![index - 1];
          const continued = Boolean(
            prev && authorKey(prev) === authorKey(message) && message.at - prev.at < 5 * 60_000,
          );
          return (
            <PairMessageRow
              key={message.messageId}
              pair={pair}
              message={message}
              me={me}
              continued={continued}
            />
          );
        })}
      </div>
    </div>
  );
}

/** "Claude Code 2 (Pepe)" names its harness first: "Claude Code". */
export function harnessOfLabel(label: string): string {
  return label.replace(/( \d+)? \(.*\)$/, "");
}

function authorKey(message: PairMessage): string {
  return `${message.from.kind}:${"id" in message.from ? message.from.id : message.from.name}`;
}

function PairMessageRow({
  pair,
  message,
  me,
  continued,
}: {
  pair: Pair;
  message: PairMessage;
  me: string | undefined;
  continued: boolean;
}) {
  const from = message.from;
  // Only what you wrote yourself is yours; a run of yours names itself, on the left.
  const mine = from.kind === "person" && "id" in from && from.id === me;
  const speaker = from.name;
  const face = (() => {
    if (from.kind === "run") {
      // A run that has left the Pair still has its label, which starts with its harness's name.
      const run = pair.runs.find((r) => r.id === from.id);
      return (
        <HarnessMark
          harness={run?.harness ?? harnessOfLabel(from.name)}
          size={28}
          title={from.name}
        />
      );
    }
    if (from.kind === "agent") return <Face who={{ name: from.name, kind: "agent" }} size={28} />;
    const person = pair.people.find((p) => "id" in from && p.id === from.id);
    return <PersonFace person={{ name: from.name, avatarUrl: person?.avatarUrl }} size={28} />;
  })();
  const at = new Date(message.at);
  const askLink = useAccountAct(api.pairs.attachmentLink);
  const link = useCallback(
    async (index: number, download: boolean) => {
      const made = await askLink({
        messageId: message.messageId,
        attachmentIndex: index,
        download,
      });
      return made && typeof made === "object" ? made : undefined;
    },
    [askLink, message.messageId],
  );
  return (
    <div
      className={`msg ${continued ? "cont" : ""} ${mine ? "mine right" : ""}`}
      data-message={message.messageId}
      data-seq={message.seq}
    >
      {mine ? null : continued ? <span className="msg-face-gap" /> : face}
      <div className="msg-body" style={{ minWidth: 0 }}>
        {continued ? null : (
          <div className="msg-head">
            {mine ? null : <b>{speaker}</b>}
            {from.kind === "run" ? (
              <span
                className="tag"
                title={`${from.person.name}'s run: ${from.person.name} answers for what it says.`}
              >
                Run, {from.person.name} answers for it
              </span>
            ) : from.kind === "agent" ? (
              <span
                className="tag"
                title={`An agent ${from.person.name} is accountable for. It can do at most what ${from.person.name} can.`}
              >
                Agent
              </span>
            ) : null}
            <time className="muted" dateTime={at.toISOString()} title={at.toLocaleString()}>
              {formatTime(message.at)}
            </time>
          </div>
        )}
        {message.body.trim() ? (
          <div className="bubble-line">
            <div className="bubble">
              <MessageBody
                format="markdown"
                body={message.body}
                title={`Message from ${speaker}`}
              />
            </div>
          </div>
        ) : null}
        {message.attachments ? (
          <Attachments
            attachments={message.attachments}
            link={link}
            from={{ name: speaker, at: message.at }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The box to write in a live Pair: Enter sends, Shift+Enter starts a new line. Images and files go
 * with a message (ADR 0048): attached with the paperclip, pasted, or dropped on the box.
 */
function PairComposer({
  pairId,
  title,
  initialMissed,
}: {
  pairId: string;
  title: string;
  initialMissed?: string[] | undefined;
}) {
  const post = useAccountAct(api.pairs.post);
  const attachUrl = useAccountAct(api.pairs.attachUrl);
  const files = useUploads(useCallback(() => attachUrl({ pairId }), [attachUrl, pairId]));
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // The runs the last message didn't reach, named until the next one is sent.
  const [missed, setMissed] = useState<string[]>(initialMissed ?? []);
  const box = useRef<HTMLTextAreaElement>(null);
  // The box grows with what's written, up to the cap its style sets.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const canSend = !busy && !files.uploading && (text.trim().length > 0 || files.ready.length > 0);
  const send = async () => {
    const sent = text;
    const body = sent.trim();
    const attached = files.ready;
    if (!canSend) return;
    setBusy(true);
    const done = await post({
      pairId,
      text: body,
      ...(attached.length ? { attachments: attached.map((p) => p.uploaded!) } : {}),
    });
    setBusy(false);
    // Clear only what was sent: anything typed or attached while it was on its way stays in the box.
    if (done !== undefined) {
      setText((now) => (now.startsWith(sent) ? now.slice(sent.length).trimStart() : now));
      files.dropThumbs(attached);
      files.setPending((all) => all.filter((p) => !attached.includes(p) && p.status !== "failed"));
      setMissed(typeof done === "object" && done.notDelivered ? done.notDelivered : []);
    }
    box.current?.focus();
  };
  return (
    <div className="composer" {...fileDrop(files.addFiles)}>
      <div className="composer-box">
        {files.pending.some((p) => p.status !== "failed") ? (
          <ul className="pending-files" aria-label="Attached to this message">
            <PendingFileChips pending={files.pending} onRemove={files.removeFile} />
          </ul>
        ) : null}
        <PendingFileErrors pending={files.pending} onRemove={files.removeFile} />
        <div className="composer-line">
          <div className="composer-tool">
            <Tip label="Attach images or files. You can also paste or drop them here.">
              <button
                className="icon-btn"
                type="button"
                aria-label="Attach images or files"
                onClick={() => fileInput.current?.click()}
              >
                <Icon name="paperclip" size={16} />
              </button>
            </Tip>
          </div>
          {/* Enter sends and Shift+Enter starts a new line (submitShortcut). */}
          <Textarea
            ref={box}
            className="textarea grow-box pair-input"
            rows={1}
            value={text}
            placeholder={`Message the Pair with ${title}`}
            aria-label="Message the Pair"
            submitShortcut="enter"
            onSubmit={() => void send()}
            onValueChange={setText}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.files];
              if (pasted.length === 0) return;
              event.preventDefault();
              files.addFiles(pasted);
            }}
          />
          <Tip label="Send">
            <Button
              className="icon-btn composer-send"
              disabled={!canSend}
              aria-label="Send"
              onClick={send}
            >
              <Icon name="arrow-up" size={16} />
            </Button>
          </Tip>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          onChange={(event) => {
            files.addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </div>
      {missed.length ? (
        <p className="pair-not-delivered" role="status">
          <Icon name="alert" size={14} />
          <span>{notDeliveredLine(missed)}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * A fresh pair code, shown once: the room keeps only its hash, so closing this forgets it. It
 * counts down its 10 minutes, and once it expires offers a new one. It is a Popover's content: the
 * caller holds the Popover and its trigger, and each opening makes one code.
 */
export function PairCodePop({ pairId }: { pairId: string }) {
  return (
    <PopoverContent
      className="pop pair-code-pop"
      aria-label="Pair code"
      side="bottom"
      align="end"
      sideOffset={6}
      collisionPadding={8}
    >
      <FreshCode pairId={pairId} />
    </PopoverContent>
  );
}

function FreshCode({ pairId }: { pairId: string }) {
  const make = useAccountAct(api.pairs.code);
  const [made, setMade] = useState<PairCode | null | undefined>(undefined);
  const asked = useRef(false);
  const fresh = async () => {
    setMade(undefined);
    const result = await make({ pairId });
    setMade(result && typeof result === "object" ? result : null);
  };
  useEffect(() => {
    // Once per opening, even when React runs effects twice.
    if (asked.current) return;
    asked.current = true;
    void fresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const now = useNow(1000);
  const left = made ? codeTimeLeft(made.expiresAt, now) : null;
  return (
    <>
      <div className="pop-title">Pair code</div>
      {made === undefined ? (
        <p className="muted pair-code-note">Making a code…</p>
      ) : made === null ? (
        <p className="muted pair-code-note">No code was made. Try again.</p>
      ) : left ? (
        <>
          <div className="pair-code-row">
            <code className="pair-code" aria-label={`Pair code ${made.code.split("-").join(" ")}`}>
              {made.code}
            </code>
            <CopyButton text={made.code} />
          </div>
          <p className="pair-code-note">
            It works once, for the next <span className="mono">{left}</span>. You'll see it only
            now.
          </p>
          <p className="pair-code-note muted">
            Give it to the person who should join. In their Claude Code or Codex session, they run{" "}
            <Cmd text={`uplink pair ${made.code}`} />, or they join in the app with Join with a
            code.
          </p>
        </>
      ) : (
        <p className="pair-code-note">This code expired.</p>
      )}
      {made === null || (made && !left) ? (
        <div className="row-flex">
          <button className="btn primary" type="button" onClick={() => void fresh()}>
            Make a new code
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * Who is in a Pair, from the faces button in its header: its people, its live runs and its
 * agents, then Leave and End. Both are hard to undo, so each asks once more in place, as leaving a
 * private channel does.
 */
function PairPeople({
  pair,
  title,
  onLeaving,
  onLeft,
  onStay,
}: {
  pair: Pair;
  title: string;
  onLeaving: () => void;
  onLeft: () => void;
  onStay: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"leave" | "end" | null>(null);
  const leave = useAccountAct(api.pairs.leave);
  const end = useAccountAct(api.pairs.end);
  const show = (next: boolean) => {
    setOpen(next);
    if (!next) setConfirm(null);
  };
  const ended = pair.endedAt !== undefined;
  const others = othersOf(pair);
  const personName = useMemo(() => new Map(pair.people.map((p) => [p.id, p.name])), [pair.people]);

  return (
    <Popover open={open} onOpenChange={show}>
      <Tip label="Who's in this Pair">
        <PopoverTrigger
          className="members-btn"
          aria-label={`Who's in this Pair, ${pair.people.length} ${pair.people.length === 1 ? "person" : "people"}`}
        >
          <span className="dm-faces">
            {others.slice(0, 3).map((p) => (
              <PersonFace key={p.id} person={p} size={24} />
            ))}
          </span>
          <span className="members-count">{pair.people.length}</span>
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        className="pop members-pop pair-people"
        aria-label={`Who's in the Pair with ${title}`}
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={8}
      >
        <div className="pop-title">People</div>
        <ul className="pick-list members-list" aria-label="People">
          {pair.people.map((p) => (
            <li key={p.id} className="member-row">
              <PersonFace person={p} size={24} />
              <span className="grow truncate">{p.name}</span>
              {isYou(p) ? <span className="muted">You</span> : null}
            </li>
          ))}
        </ul>
        {pair.runs.length ? (
          <>
            <div className="pop-title">Live runs</div>
            <ul className="pick-list members-list" aria-label="Live runs">
              {pair.runs.map((run) => (
                <li key={run.id} className="member-row">
                  <HarnessMark harness={run.harness} state="working" size={24} />
                  <span className="grow truncate">{run.label}</span>
                  <span className="muted">Live</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted pair-people-note">
            {ended ? "Its runs left when it ended." : "No run is in it right now."}
          </p>
        )}
        {pair.agents.length ? (
          <>
            <div className="pop-title">Agents</div>
            <ul className="pick-list members-list" aria-label="Agents">
              {pair.agents.map((agent) => (
                <li key={agent.id} className="member-row">
                  <Face who={{ name: agent.name, kind: "agent" }} size={24} />
                  <span className="grow truncate">{agent.name}</span>
                  {"person" in agent && agent.person ? (
                    <span className="muted truncate">{personName.get(agent.person)}'s</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <div className="sep" />
        {confirm ? (
          <div className="leave-confirm">
            <p>
              {confirm === "end"
                ? "End this Pair for everyone? Its runs and agents leave, its codes stop working and nobody can write in it. Everyone can still read it."
                : "Leave this Pair? You can't read it after, and your runs in it leave with you. If one person is left, it ends."}
            </p>
            <div className="row-flex">
              <Button
                className="btn"
                onClick={async () => {
                  if (confirm === "end") {
                    if (await end({ pairId: pair.pairId })) show(false);
                    return;
                  }
                  onLeaving();
                  if (await leave({ pairId: pair.pairId })) {
                    show(false);
                    onLeft();
                  } else onStay();
                }}
              >
                {confirm === "end" ? "End Pair" : "Leave"}
              </Button>
              <button
                className="btn ghost"
                type="button"
                autoFocus
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" onClick={() => setConfirm("leave")}>
              <span className="pair-action-icon">
                <Icon name="exit" />
              </span>
              <span className="grow">Leave this Pair</span>
            </button>
            {ended ? null : (
              <button type="button" onClick={() => setConfirm("end")}>
                <span className="pair-action-icon">
                  <Icon name="stop" />
                </span>
                <span className="grow">End this Pair for everyone</span>
              </button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
