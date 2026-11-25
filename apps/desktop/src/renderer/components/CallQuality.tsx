import "./calls.css";
/**
 * Call quality controls (issue #87, DESIGN.md "Calls"): a channel's voice quality in its call
 * actions, the quality of a screen share in the share picker and on your own shared screen, and
 * how you watch someone else's. Each choice above the team's limit is unavailable and says why.
 */
import { useState, type KeyboardEvent } from "react";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Toggle } from "@ui-sdk/react/toggle";
import { api, type ChannelRow, type Id } from "../lib/api";
import { useCall, type ScreenView } from "../lib/call";
import {
  CALL_QUALITIES,
  choiceOf,
  fpsOf,
  LIMIT_LABEL,
  SHARE,
  SHARE_CHOICES,
  SHARE_QUALITIES,
  shareAllowed,
  VOICE,
  voiceAllowed,
  type CallQuality,
  type CallQualityLimit,
  type ShareQuality,
} from "../lib/callQuality";
import { useAct, useRoomQuery, useSession } from "../lib/session";
import { Icon } from "./Icon";
import { Tip } from "./Tip";

const VOICE_NOTE: Record<CallQuality, string> = {
  standard: "For talking, with noise suppression.",
  high: "Clearer voices, at twice the bitrate.",
  music: "Stereo, with noise suppression and auto gain off.",
};

/** "A", "A and B", "A, B and C". */
function listOf(names: string[]): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The team's limit, from teams.settings: none (everything allowed) until it loads. */
export function useCallQualityLimit(): CallQualityLimit {
  return useRoomQuery(api.teams.settings, {})?.callQualityLimit ?? "none";
}

/** Why some choices are unavailable, in one sentence, or null when all are allowed. */
export function aboveLimit(labels: string[], limit: CallQualityLimit): string | null {
  if (labels.length === 0) return null;
  return `${listOf(labels)} ${labels.length === 1 ? "is" : "are"} above your team's limit (${LIMIT_LABEL[limit]}). An admin can change it in Settings, Calls.`;
}

/** "this conversation" for a direct message, else "#general". */
export function voiceWhere(channel: Pick<ChannelRow, "kind" | "name">): string {
  return channel.kind === "direct" ? "this conversation" : `#${channel.name}`;
}

/**
 * The voice qualities as a menu's radio items, with who can change them and the team's limit. It goes
 * inside a MenuContent or MenuSubContent (`pop quality-choices`), which the caller places.
 */
export function VoiceQualityChoices({
  channelId,
  onChosen,
}: {
  channelId: Id<"channels">;
  /** After a choice is saved, or the saved one picked again. */
  onChosen: () => void;
}) {
  const session = useSession();
  const channel = useRoomQuery(api.channels.list, {})?.find((c) => c.channelId === channelId);
  const limit = useCallQualityLimit();
  const set = useAct(api.channels.setCallQuality);
  if (!channel) return null;
  const canChange = channel.kind !== "channel" || session.isAdmin;
  const unavailable = CALL_QUALITIES.filter((q) => !voiceAllowed(q, limit)).map(
    (q) => VOICE[q].label,
  );
  const capped = channel.callQualityChosen !== channel.callQuality;
  const choose = async (quality: CallQuality) => {
    // Against the saved choice: picking the quality a lower limit holds a higher choice at saves
    // it, so the channel doesn't jump back up when the limit rises.
    if (quality === channel.callQualityChosen || (await set({ channelId, quality }))) onChosen();
  };
  // The checked item reports no change when it's picked again, so it answers its own press.
  const again = (quality: CallQuality, disabled: boolean) => ({
    onClick: () => {
      if (!disabled) void choose(quality);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (!disabled && (event.key === "Enter" || event.key === " ")) void choose(quality);
    },
  });
  return (
    <>
      <MenuRadioGroup
        value={channel.callQuality}
        onValueChange={(quality) => void choose(quality as CallQuality)}
      >
        <MenuGroupLabel className="pop-title">
          Voice quality in {voiceWhere(channel)}
        </MenuGroupLabel>
        {CALL_QUALITIES.map((quality) => {
          const disabled = !canChange || !voiceAllowed(quality, limit);
          return (
            <MenuRadioItem
              key={quality}
              value={quality}
              label={VOICE[quality].label}
              disabled={disabled}
              closeOnSelect={false}
              {...(channel.callQuality === quality ? again(quality, disabled) : {})}
            >
              <span className="quality-tick">
                {channel.callQuality === quality ? <Icon name="tick" /> : null}
              </span>
              <span className="grow quality-choice">
                <span>{VOICE[quality].label}</span>
                <span className="quality-note">{VOICE_NOTE[quality]}</span>
              </span>
              <span className="quality-rate">
                {VOICE[quality].kbps} kbps, {VOICE[quality].stereo ? "stereo" : "mono"}
              </span>
            </MenuRadioItem>
          );
        })}
      </MenuRadioGroup>
      <MenuSeparator />
      <div className="quality-foot">
        {canChange ? (
          <p>Changes the call for everyone in it, at once.</p>
        ) : (
          <p>Only admins can change this in a team channel.</p>
        )}
        {capped ? (
          <p>
            Set to {VOICE[channel.callQualityChosen].label}; your team's limit keeps calls at{" "}
            {VOICE[channel.callQuality].label}.
          </p>
        ) : null}
        {canChange && unavailable.length ? <p>{aboveLimit(unavailable, limit)}</p> : null}
      </div>
    </>
  );
}

/**
 * The voice quality of a channel's calls as a button that opens its menu. Choosing one applies to
 * everyone in the call at once. In a team channel only admins choose; in a private channel or a
 * direct message, any member.
 */
export function VoiceQuality({ channelId }: { channelId: Id<"channels"> }) {
  const channel = useRoomQuery(api.channels.list, {})?.find((c) => c.channelId === channelId);
  const [open, setOpen] = useState(false);
  if (!channel) return null;
  return (
    <div className="quality-wrap">
      <Menu open={open} onOpenChange={setOpen}>
        <Tip label={`Voice quality: ${VOICE[channel.callQuality].label}`}>
          <MenuTrigger className="btn" aria-label={`Voice: ${VOICE[channel.callQuality].label}`}>
            <Icon name="volume" />{" "}
            <span className="btn-label">Voice: {VOICE[channel.callQuality].label}</span>
          </MenuTrigger>
        </Tip>
        <MenuContent
          className="pop quality-choices quality-pop"
          aria-label={`Voice quality in ${voiceWhere(channel)}`}
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          <VoiceQualityChoices channelId={channelId} onChosen={() => setOpen(false)} />
        </MenuContent>
      </Menu>
    </div>
  );
}

/** What a 60 fps share costs, said once wherever one is picked. */
export const SIXTY_FPS_NOTE =
  "60 fps uses more bandwidth and processor. If your computer or connection can't keep up, the frame rate drops and the share goes on.";

/**
 * The share choices as a segmented control (Source with its frame rate beside it), with what the
 * chosen one sends, what 60 fps costs, and why any are unavailable. `windowsNote` is the Windows
 * capture limit for the screen picked, when it applies.
 */
export function ShareQualityChoice({
  value,
  onChange,
  limit,
  labelId,
  windowsNote,
  initialFocus = false,
}: {
  value: ShareQuality;
  onChange: (quality: ShareQuality) => void;
  limit: CallQualityLimit;
  labelId: string;
  windowsNote?: string | null;
  /** In a dialog, the chosen quality is where focus starts (components/Dialog.tsx). */
  initialFocus?: boolean;
}) {
  const unavailable = SHARE_CHOICES.filter((q) => !shareAllowed(q, limit)).map(
    (q) => SHARE[q].label,
  );
  const choice = choiceOf(value);
  return (
    <>
      <div className="share-quality-row">
        <SegmentedControl
          className="seg"
          aria-labelledby={labelId}
          value={choice}
          // Source keeps the frame rate it had.
          onValueChange={(q) => {
            if (q)
              onChange(q === "source" && value === "source60" ? "source60" : (q as ShareQuality));
          }}
        >
          {SHARE_CHOICES.map((q) => (
            <SegmentedControlItem
              key={q}
              value={q}
              disabled={!shareAllowed(q, limit)}
              data-dialog-initial-focus={initialFocus && q === choice ? "" : undefined}
            >
              <span className="call-quality-label">{SHARE[q].label}</span>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        {choice === "source" ? (
          <SegmentedControl
            className="seg"
            aria-label="Source frame rate"
            value={value}
            onValueChange={(q) => {
              if (q) onChange(q as ShareQuality);
            }}
          >
            {(["source", "source60"] as const).map((q) => (
              <SegmentedControlItem key={q} value={q}>
                <span className="call-quality-label">{fpsOf(q)} fps</span>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        ) : null}
      </div>
      <span className="hint measure">
        {SHARE[value].summary}
        {fpsOf(value) === 60 ? ` ${SIXTY_FPS_NOTE}` : ""}
      </span>
      {fpsOf(value) === 60 && windowsNote ? (
        <span className="hint measure">{windowsNote}</span>
      ) : null}
      {unavailable.length ? (
        <span className="hint measure">{aboveLimit(unavailable, limit)}</span>
      ) : null}
    </>
  );
}

/** "Balanced, 1080p 30 fps": a choice in one line, for the share's own tile. */
function shareLine(quality: ShareQuality): string {
  const { preset } = SHARE[quality];
  const size =
    quality === "source" || quality === "source60" ? "its own size" : `${preset.height}p`;
  return `${SHARE[quality].label}, ${size}, ${fpsOf(quality)} fps`;
}

const VIEW_HINT: Record<ScreenView, string> = {
  auto: "As much as this tile shows and your connection allows",
  low: "The lower layer only, for a slow connection",
};

/**
 * The controls on a shared screen's tile. Someone else's: how you watch it (Auto, as adaptive
 * stream picks for the tile's size, or Low, its low layer for a slow connection). Yours: its
 * quality, which shares it again. Both: Expand, to watch it full size.
 */
export function ScreenTools({
  join,
  isLocal,
  expanded,
  onExpand,
}: {
  join: string;
  isLocal: boolean;
  expanded: boolean;
  onExpand: () => void;
}) {
  const call = useCall();
  const limit = useCallQualityLimit();
  const views: ScreenView[] = ["auto", "low"];
  const view = call.screenView.get(join) ?? "auto";
  return (
    <div className="tile-tools">
      {isLocal && call.shareQuality ? (
        <Field className="tile-tools-label">
          <FieldLabel>Quality</FieldLabel>
          <Select
            value={call.shareQuality}
            items={SHARE_QUALITIES.map((quality) => ({
              value: quality,
              label: shareLine(quality),
              disabled: !shareAllowed(quality, limit),
            }))}
            onValueChange={(quality) => {
              if (quality) void call.changeShareQuality(quality as ShareQuality);
            }}
          >
            <Tip label={SHARE[call.shareQuality].summary}>
              <SelectTrigger className="select tile-select">
                <SelectValue />
              </SelectTrigger>
            </Tip>
            <SelectContent className="pop tile-select-list" collisionPadding={8}>
              {SHARE_QUALITIES.map((quality) => (
                <SelectItem
                  key={quality}
                  value={quality}
                  label={shareLine(quality)}
                  disabled={!shareAllowed(quality, limit)}
                >
                  <span className="grow">
                    {shareLine(quality)}
                    {shareAllowed(quality, limit) ? "" : ", above your team's limit"}
                  </span>
                  <SelectItemIndicator>
                    <Icon name="check" size={14} />
                  </SelectItemIndicator>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {!isLocal ? (
        <>
          <span className="tile-tools-label" id={`view-${join}`}>
            Stream quality
          </span>
          <SegmentedControl
            className="seg"
            aria-labelledby={`view-${join}`}
            value={view}
            onValueChange={(v) => {
              if (v) call.setScreenView(join, v as ScreenView);
            }}
          >
            {views.map((v) => (
              <Tip key={v} label={VIEW_HINT[v]}>
                <SegmentedControlItem value={v}>
                  {v === "auto" ? "Auto" : "Low"}
                </SegmentedControlItem>
              </Tip>
            ))}
          </SegmentedControl>
        </>
      ) : null}
      <Tip label={expanded ? "Shrink" : "Expand"}>
        <Toggle
          className="btn icon"
          pressed={expanded}
          aria-label={expanded ? "Shrink the screen" : "Expand the screen"}
          onPressedChange={onExpand}
        >
          <Icon name={expanded ? "shrink" : "expand"} />
        </Toggle>
      </Tip>
    </div>
  );
}
