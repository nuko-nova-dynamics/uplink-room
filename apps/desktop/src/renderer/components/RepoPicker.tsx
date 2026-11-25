import { useId, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@ui-sdk/react/combobox";
import { normalizeRepo, repoKey } from "@uplink-room/backend/repos";
import { api } from "../lib/api";
import { useSoftRoomQueries, useSoftRoomQuery } from "../lib/session";
import { Icon } from "./Icon";
import { Tip } from "./Tip";
import "./repoPicker.css";

export type SyncedRepo = FunctionReturnType<typeof api.github.repos>[number];

/** github.repoStatus answers at most this many repos a call. */
export const STATUS_BATCH = 100;

/** `owner/name`, a GitHub URL, or `host/owner/name`: what a person can type for a repo that isn't synced. */
export function looksLikeRepo(text: string): boolean {
  const key = repoKey(text.trim());
  return /^[^\s/]+(\/[^\s/]+){2,}$/.test(key);
}

type Option = { kind: "synced"; repo: SyncedRepo } | { kind: "typed"; repo: string };

/** The string a project keeps for an option. */
const valueOf = (option: Option) => (option.kind === "synced" ? option.repo.repo : option.repo);

/**
 * The repos a project lists (ADR 0020): search the synced repos, the ones the team's connected
 * GitHub accounts give it, or type `owner/name` for one that isn't connected. Each chosen repo
 * says whether a connected account gives it. The search is a UI SDK Combobox that picks several.
 */
export function RepoPicker({
  repos,
  onChange,
  onPickSynced,
  inputId,
}: {
  repos: string[];
  onChange: (next: string[]) => void;
  /** A synced repo was picked, such as for New project to take its name. */
  onPickSynced?: (repo: SyncedRepo) => void;
  inputId?: string;
}) {
  const ownId = useId();
  const id = inputId ?? `${ownId}-search`;
  const [query, setQuery] = useState("");
  // Whether the person wants the results: the search has focus and they weren't dismissed.
  const [open, setOpen] = useState(false);
  // Soft: GitHub being unreachable or not set up never takes the dialog down; typing still works.
  const accounts = useSoftRoomQuery(api.github.accounts, {});
  const connected = (accounts?.accounts.length ?? 0) > 0;
  const results = useSoftRoomQuery(
    api.github.repos,
    open && connected ? { search: query, limit: 8 } : "skip",
  );
  const batches: { repos: string[] }[] = [];
  for (let i = 0; i < repos.length; i += STATUS_BATCH)
    batches.push({ repos: repos.slice(i, i + STATUS_BATCH) });
  // A batch that failed (null) leaves its repos without a status rather than guessing one.
  const statuses = useSoftRoomQueries(api.github.repoStatus, batches, null);
  const chosen = new Set(repos.map(repoKey));
  const typed = query.trim();
  const options: Option[] = [
    ...(results ?? [])
      .filter((r) => !chosen.has(repoKey(r.repo)))
      .map((repo) => ({ kind: "synced" as const, repo })),
    // Stored as projects store it: `owner/name` becomes `github.com/owner/name`, which a run's repo
    // must be for the bridge to find the T3 Code project.
    ...(looksLikeRepo(typed) &&
    !chosen.has(repoKey(typed)) &&
    !(results ?? []).some((r) => repoKey(r.repo) === repoKey(typed))
      ? [{ kind: "typed" as const, repo: normalizeRepo(typed) }]
      : []),
  ];
  // With nothing to offer and no answer to say so, no list opens.
  const showList = open && (options.length > 0 || (connected && results !== undefined));
  const info = new Map(
    statuses.flatMap((batch) => (batch ?? []).map((s) => [s.repo, s.synced] as const)),
  );

  return (
    <div className="repo-picker">
      <Combobox
        multiple
        value={repos}
        // Picking adds a repo. One leaves through its Remove button, never by Backspace here.
        onValueChange={(next, details) => {
          const added = (next as string[]).filter((repo) => !repos.includes(repo));
          if (added.length === 0) {
            details.cancel();
            return;
          }
          onChange([...repos, ...added]);
          for (const repo of added) {
            const option = options.find((o) => valueOf(o) === repo);
            if (option?.kind === "synced") onPickSynced?.(option.repo);
          }
        }}
        query={query}
        onQueryChange={setQuery}
        open={showList}
        onOpenChange={setOpen}
        // The room searches; every option it returns stays.
        filter={false}
        autoHighlight
      >
        <div className="repo-search">
          <Icon name="search" />
          <ComboboxInput
            id={id}
            className="input"
            placeholder={connected ? "Search synced repos, or type owner/name" : "owner/name"}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              // Escape empties the search first and goes no further: the list, then the dialog,
              // close on the next ones.
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
        </div>
        <ComboboxContent className="repo-results" side="bottom" align="start" sideOffset={4}>
          <ComboboxEmpty className="repo-empty">
            {typed
              ? `No synced repo matches "${typed}". Type it as owner/name to add it anyway.`
              : "Every synced repo is already listed."}
          </ComboboxEmpty>
          <ComboboxList aria-label="Repos">
            {options.map((option) => (
              <ComboboxItem
                key={option.kind === "synced" ? option.repo.githubId : `typed-${option.repo}`}
                value={valueOf(option)}
                label={option.kind === "synced" ? option.repo.fullName : option.repo}
                className="repo-option"
              >
                {option.kind === "synced" ? (
                  <>
                    <Icon name={option.repo.private ? "lock" : "repo"} />
                    <span className="mono truncate">{option.repo.fullName}</span>
                    <span className="meta">
                      {[
                        option.repo.private ? "Private" : null,
                        option.repo.archived ? "Archived" : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  </>
                ) : (
                  <>
                    <Icon name="plus" />
                    <span className="truncate">
                      Add <span className="mono">{option.repo}</span>
                    </span>
                    <span className="meta">Not connected</span>
                  </>
                )}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {accounts && !connected ? (
        <span className="hint">
          Connect GitHub in Settings, then GitHub, to pick from your repos.
        </span>
      ) : null}
      {repos.length > 0 ? (
        <ul className="repo-chosen" aria-label="Chosen repos">
          {repos.map((repo) => {
            const known = info.has(repo);
            const synced = info.get(repo);
            return (
              <li key={repo}>
                <Icon name={synced?.private ? "lock" : "repo"} />
                <span className="mono truncate" title={repo}>
                  {synced ? synced.fullName : repo}
                </span>
                <span className="meta">
                  {!known
                    ? ""
                    : synced
                      ? [
                          synced.private ? "Private" : null,
                          synced.archived ? "Archived" : null,
                          `from ${synced.account}`,
                        ]
                          .filter(Boolean)
                          .join(", ")
                      : "Not connected"}
                </span>
                <Tip label="Remove">
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={`Remove ${repo}`}
                    onClick={() => onChange(repos.filter((r) => r !== repo))}
                  >
                    <Icon name="close" />
                  </button>
                </Tip>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
