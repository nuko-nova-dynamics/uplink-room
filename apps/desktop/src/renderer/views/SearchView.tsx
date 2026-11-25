import { useEffect, useState } from "react";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { api, type Id, type SearchResult } from "../lib/api";
import { sameDay, searchExcerpt } from "../lib/chat";
import { useRoomQuery, useSession } from "../lib/session";
import { Empty } from "../components/Empty";
import { ConversationFace as MemberFace } from "../components/chat/ConversationFace";
import { Icon } from "../components/Icon";
import type { Nav } from "../Shell";
import "./search.css";

type Filters = {
  channelId: string;
  authorId: string;
  /** Any time, a recent stretch (its start fixed when it was picked), or dates you choose. */
  when: "" | "today" | "week" | "month" | "custom";
  since?: number;
  from: string;
  to: string;
  has: "" | "attachment" | "link";
};

const NO_FILTERS: Filters = { channelId: "", authorId: "", when: "", from: "", to: "", has: "" };

/** A search as messages.search takes it: the words, any filters, and the order. It travels with a result you open. */
export type SearchSpec = {
  query: string;
  channelId?: Id<"channels">;
  authorId?: Id<"members">;
  from?: number;
  to?: number;
  has?: "attachment" | "link";
  sort?: "newest";
};

/** The start of a recent stretch, from now. */
function stretchStart(when: Filters["when"]): number | undefined {
  const now = new Date();
  if (when === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (when === "week") return now.getTime() - 7 * 86_400_000;
  if (when === "month") return now.getTime() - 30 * 86_400_000;
  return undefined;
}

/** A day's start, or end, in this computer's time zone, from an <input type="date"> value. */
function dayBound(value: string, end: boolean): number | undefined {
  if (!value) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return end ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
}

const WHEN_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "week", label: "Past 7 days" },
  { value: "month", label: "Past 30 days" },
  { value: "custom", label: "Between dates" },
] as const satisfies readonly { value: Filters["when"]; label: string }[];

const HAS_OPTIONS = [
  { value: "", label: "Any message" },
  { value: "attachment", label: "With attachments" },
  { value: "link", label: "With links" },
] as const satisfies readonly { value: Filters["has"]; label: string }[];

const SORT_OPTIONS = [
  { value: "relevance", label: "Best match first" },
  { value: "newest", label: "Newest first" },
] as const;

/** The value a filter's "any" option ("Everywhere", "Anyone"…) has in its select; the filter keeps "". */
const ANY = "any";

/**
 * One of the search's filters, on UI SDK's Select: a soft pill with the app's chevron, and a list
 * of its options. An option whose value is "" (no filter) is chosen as ANY in the select.
 */
function FilterSelect<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
}) {
  const items = options.map((o) => ({ value: o.value || ANY, label: o.label }));
  return (
    <span className="select-wrap">
      <Select
        items={items}
        value={value || ANY}
        onValueChange={(next) => {
          const option = options.find((o) => (o.value || ANY) === next);
          if (option) onChange(option.value);
        }}
      >
        <SelectTrigger className="input" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="pop" side="bottom" align="start" sideOffset={4}>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} label={item.label}>
              <span className="grow">{item.label}</span>
              <SelectItemIndicator>
                <Icon name="check" size={14} />
              </SelectItemIndicator>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Icon name="chevron-down" size={14} />
    </span>
  );
}

/**
 * Search (spec #63): message text across every channel and direct message you can see, narrowed by
 * channel, person, dates, or messages with attachments or links. A result opens at the message.
 */
export function SearchView({ initial, nav }: { initial: string; nav: Nav }) {
  const session = useSession();
  const channels = useRoomQuery(api.channels.list, {});
  const [query, setQuery] = useState(initial);
  const [typed, setTyped] = useState(initial);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [sort, setSort] = useState<"relevance" | "newest">("relevance");
  useEffect(() => {
    setQuery(initial.trim());
    setTyped(initial);
  }, [initial]);
  useEffect(() => setCursors([null]), [query, filters, sort]);

  const args: SearchSpec = {
    query,
    ...(sort === "newest" ? { sort: "newest" as const } : {}),
    ...(filters.channelId ? { channelId: filters.channelId as Id<"channels"> } : {}),
    ...(filters.authorId ? { authorId: filters.authorId as Id<"members"> } : {}),
    ...(filters.since !== undefined ? { from: filters.since } : {}),
    ...(filters.when === "custom" && dayBound(filters.from, false) !== undefined
      ? { from: dayBound(filters.from, false)! }
      : {}),
    ...(filters.when === "custom" && dayBound(filters.to, true) !== undefined
      ? { to: dayBound(filters.to, true)! }
      : {}),
    ...(filters.has ? { has: filters.has } : {}),
  };
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const names = new Map(session.members.map((m) => [m.memberId as string, m.name]));

  return (
    <>
      <header className="main-head search-head">
        <h1 className="sr-only">Search</h1>
        <span className="grow" />
        {/* Where you type: a centered pill in the title row, as Grok Bot keeps search in its own place.
            Enter searches. */}
        <form
          className="head-id search-box"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(typed.trim());
          }}
        >
          <Icon name="search" />
          <Input
            type="search"
            value={typed}
            autoFocus
            placeholder="Search messages"
            aria-label="Search messages"
            onValueChange={setTyped}
          />
        </form>
        <span className="grow" />
      </header>
      <div className="main-body search-view">
        {/* The box above is where you type; this says what is being searched. */}
        {query ? <h2 className="search-query">Messages with "{query}"</h2> : null}
        <div className="search-filters" role="group" aria-label="Narrow the search">
          <FilterSelect
            label="Channel"
            value={filters.channelId}
            options={[
              { value: "", label: "Everywhere" },
              ...(channels ?? []).map((c) => ({
                value: c.channelId as string,
                label: c.kind === "direct" ? c.name : `#${c.name}`,
              })),
            ]}
            onChange={(value) => set("channelId", value)}
          />
          <FilterSelect
            label="From"
            value={filters.authorId}
            options={[
              { value: "", label: "Anyone" },
              ...session.members.map((m) => ({ value: m.memberId as string, label: m.name })),
            ]}
            onChange={(value) => set("authorId", value)}
          />
          <FilterSelect
            label="When"
            value={filters.when}
            options={WHEN_OPTIONS}
            onChange={(when) => {
              const since = stretchStart(when);
              setFilters((f) => {
                const { since: _old, ...rest } = f;
                return { ...rest, when, ...(since !== undefined ? { since } : {}) };
              });
            }}
          />
          {filters.when === "custom" ? (
            <>
              <label className="search-date">
                <span className="muted">From</span>
                <Input
                  className="input"
                  type="date"
                  value={filters.from}
                  onValueChange={(value) => set("from", value)}
                />
              </label>
              <label className="search-date">
                <span className="muted">To</span>
                <Input
                  className="input"
                  type="date"
                  value={filters.to}
                  onValueChange={(value) => set("to", value)}
                />
              </label>
            </>
          ) : null}
          <FilterSelect
            label="Has"
            value={filters.has}
            options={HAS_OPTIONS}
            onChange={(value) => set("has", value)}
          />
          <FilterSelect label="Order" value={sort} options={SORT_OPTIONS} onChange={setSort} />
          {JSON.stringify(filters) !== JSON.stringify(NO_FILTERS) ? (
            <button
              className="btn small ghost"
              type="button"
              onClick={() => setFilters(NO_FILTERS)}
            >
              Clear
            </button>
          ) : null}
        </div>
        {query ? (
          <div className="search-results">
            {cursors.map((cursor, i) => (
              <ResultPage
                key={`${i}-${cursor}`}
                args={{ ...args, cursor }}
                names={names}
                last={i === cursors.length - 1}
                first={i === 0}
                onMore={(next) => setCursors((all) => [...all, next])}
                // The results stay beside the channel the result opens in, filters and order too.
                onOpen={(r) =>
                  nav.go({
                    name: "channel",
                    channelId: r.channelId,
                    messageId: r.messageId,
                    search: args,
                  })
                }
              />
            ))}
          </div>
        ) : (
          <Empty>
            Type in the search box at the top of the sidebar to search every channel and direct
            message you're in.
          </Empty>
        )}
      </div>
    </>
  );
}

/** Where a result is: a channel, a private channel or a direct message. */
function placeOf(r: SearchResult): string {
  return r.channel.kind === "direct"
    ? "Direct message"
    : r.channel.kind === "private"
      ? r.channel.name
      : `#${r.channel.name}`;
}

/** One page of results, in the Search view or in a channel's Search panel (`compact`). */
export function ResultPage({
  args,
  names,
  first,
  last,
  onMore,
  onOpen,
  compact = false,
  current,
}: {
  args: { query: string; cursor: string | null } & Record<string, unknown>;
  names: Map<string, string>;
  first: boolean;
  last: boolean;
  onMore: (cursor: string) => void;
  onOpen: (result: SearchResult) => void;
  compact?: boolean;
  /** The result open now, marked in the list. */
  current?: string | undefined;
}) {
  const session = useSession();
  const page = useRoomQuery(api.messages.search, args as never);
  if (page === undefined)
    return first ? <div className="muted search-count">Searching…</div> : null;
  return (
    <>
      {first && page.results.length === 0 ? <Empty>No messages match "{args.query}".</Empty> : null}
      {first && page.results.length > 0 ? (
        <div className="search-count muted">
          {page.isDone
            ? `${page.results.length} result${page.results.length === 1 ? "" : "s"}`
            : `More than ${page.results.length} results`}
          , {args["sort"] === "newest" ? "newest first" : "best match first"}
        </div>
      ) : null}
      {page.results.map((r: SearchResult) => (
        <button
          key={r.messageId}
          type="button"
          className={`search-result ${compact ? "compact" : ""}`}
          aria-current={current === r.messageId ? "true" : undefined}
          onClick={() => onOpen(r)}
        >
          <MemberFace member={r.author} members={session.members} size={compact ? 20 : 24} />
          <span className="search-result-text">
            <span className="search-result-head">
              <b>{r.author.name}</b>
              <span className="search-result-meta">
                <span>{placeOf(r)}</span>
                {r.replyTo ? <span className="tag">In a thread</span> : null}
                <time dateTime={new Date(r.postedAt).toISOString()}>
                  {sameDay(r.postedAt, Date.now())
                    ? "Today"
                    : new Date(r.postedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                  ,{" "}
                  {new Date(r.postedAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </span>
              {r.attachments.length ? (
                <span
                  className="search-result-files"
                  title={`${r.attachments.length} attachment${r.attachments.length === 1 ? "" : "s"}`}
                >
                  <Icon name="paperclip" size={14} />
                  {r.attachments.length}
                </span>
              ) : null}
            </span>
            <span className="search-result-body">
              {searchExcerpt(r.body, args.query, (id) => names.get(id), session.me.memberId).map(
                (part, i) =>
                  part.mention ? (
                    <mark
                      key={i}
                      className={`search-mention ${part.mention === "me" ? "me" : ""} ${part.hit ? "search-hit" : ""}`}
                    >
                      {part.text}
                    </mark>
                  ) : part.hit ? (
                    <mark key={i} className="search-hit">
                      {part.text}
                    </mark>
                  ) : (
                    part.text
                  ),
              )}
            </span>
          </span>
        </button>
      ))}
      {last && !page.isDone && page.cursor ? (
        <button className="btn small" type="button" onClick={() => onMore(page.cursor!)}>
          More results
        </button>
      ) : null}
    </>
  );
}
