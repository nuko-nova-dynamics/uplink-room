import { Listbox, ListboxItem } from "@ui-sdk/react/listbox";
import type { Id } from "../lib/api";
import { useCall, type LiveCall } from "../lib/call";
import { log } from "../lib/log";
import { useStoredFlag } from "../lib/storedFlag";
import { ChannelCallMembers } from "./Call";
import { Icon } from "./Icon";
import { Tip } from "./Tip";
import "./people.css";

/** A place to talk: a channel, or a direct message while it has a call. */
export type VoiceRoom = {
  channelId: Id<"channels">;
  name: string;
  kind: string;
};

/** How many rooms show before "All voice rooms": the live ones and the open one always show. */
export const VOICE_SHOWN = 5;

/**
 * The sidebar's Voice section, as Discord lists its voice channels: every channel is a room you can
 * talk in, listed whether anyone is there or not. One click joins its call, and when nobody is talking
 * there yet, that starts it, so there is nothing separate to start. Who's in a room is listed under it.
 * The list is a UI SDK listbox: arrow keys move through it, typing jumps to a room, and the room
 * you're in is the selected one.
 */
export function VoiceRooms({
  rooms,
  liveCalls,
  openChannelId,
  onOpen,
}: {
  rooms: VoiceRoom[];
  liveCalls: LiveCall[] | undefined;
  /** The channel open in the main view, which always shows. */
  openChannelId: Id<"channels"> | undefined;
  onOpen: (channelId: Id<"channels">) => void;
}) {
  const call = useCall();
  const [all, setAll] = useStoredFlag("uplink.sidebar.allVoice", false);
  const inCall = call.status !== "idle" ? call.channelId : null;
  const callIn = (channelId: string) => liveCalls?.find((c) => c.channelId === channelId);
  // Rooms with someone in them first, in the order the list gives them otherwise.
  const ordered = [...rooms].sort(
    (a, b) => Number(Boolean(callIn(b.channelId))) - Number(Boolean(callIn(a.channelId))),
  );
  const pinned = (room: VoiceRoom) =>
    Boolean(callIn(room.channelId)) ||
    room.channelId === inCall ||
    room.channelId === openChannelId;
  const shown = all
    ? ordered
    : ordered.filter((room, index) => pinned(room) || index < VOICE_SHOWN);
  const join = (channelId: Id<"channels">) => {
    onOpen(channelId);
    if (channelId === inCall) return;
    log.info("call", "joining from the voice list", { running: Boolean(callIn(channelId)) });
    void call.join(channelId);
  };
  if (rooms.length === 0) return null;
  return (
    <>
      <Listbox
        className="voice-rooms"
        aria-label="Voice"
        activation="manual"
        value={inCall}
        onValueChange={(value) => {
          if (typeof value === "string") join(value as Id<"channels">);
        }}
      >
        {shown.map((room) => {
          const live = callIn(room.channelId);
          const here = room.channelId === inCall;
          const label = room.kind === "direct" ? room.name : `#${room.name}`;
          const who = live?.participants.map((p) => p.name) ?? [];
          return (
            <Tip
              key={room.channelId}
              side="right"
              label={
                here
                  ? "You're in this call"
                  : who.length
                    ? "Join the call"
                    : "Join voice: anyone can join you"
              }
            >
              <ListboxItem
                value={room.channelId}
                label={room.name}
                className={`nav-item voice-room ${live ? "is-live" : ""}`}
                aria-current={room.channelId === openChannelId ? "page" : undefined}
                aria-label={
                  here
                    ? `${label}, you're in this call`
                    : who.length
                      ? `${label}, join the call with ${who.join(", ")}`
                      : `${label}, join voice`
                }
                // The room you're in opens on a click or Enter (Space types into the jump-to search).
                // Another room joins through onValueChange, replacing a join still in progress.
                onClick={() => here && onOpen(room.channelId)}
                onKeyDown={(event) => {
                  if (here && event.key === "Enter") onOpen(room.channelId);
                }}
              >
                <span className="voice-room-line">
                  <Icon name="volume" />
                  <span className="label-text">{room.name}</span>
                  {here ? (
                    <span className="voice-room-here">
                      {call.status === "connected"
                        ? "Connected"
                        : call.status === "joining"
                          ? "Joining"
                          : "Reconnecting"}
                    </span>
                  ) : live ? (
                    <span className="voice-room-count" aria-hidden="true">
                      {live.participants.length}
                    </span>
                  ) : (
                    <span className="voice-room-join" aria-hidden="true">
                      Join
                    </span>
                  )}
                </span>
                {live ? <ChannelCallMembers call={live} /> : null}
              </ListboxItem>
            </Tip>
          );
        })}
      </Listbox>
      {rooms.length > shown.length || all ? (
        <button
          className="nav-item fold-toggle"
          type="button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          <Icon name={all ? "chevron" : "chevron-down"} />
          <span className="label-text">
            {all ? "Show less" : `All voice rooms (${rooms.length})`}
          </span>
        </button>
      ) : null}
    </>
  );
}
