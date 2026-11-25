/**
 * Joining a call's LiveKit room with the token from `calls.join` (ADR 0007),
 * and hearing each participant's microphone as 16 kHz mono frames.
 */
import { AudioStream, DisconnectReason, Room, RoomEvent, TrackKind, TrackSource } from "@livekit/rtc-node";

export const SAMPLE_RATE = 16_000;

/** The member a LiveKit identity belongs to (identities are `<member id>.<participation id>`). */
export function memberIdOf(identity: string): string {
  return identity.split(".")[0]!;
}

export type AudioHandlers = {
  /** One frame of a participant's microphone. `speakerId` is the LiveKit identity of that join (`memberIdOf` gives the member). */
  onAudio(speakerId: string, frame: Int16Array, at: number): void;
  /** That participant's microphone stopped (they left, or unpublished it). */
  onSpeakerGone(speakerId: string): void;
  /** LiveKit disconnected for good (it already retried), not because we left. */
  onDisconnected?(): void;
  /** Another client joined with this identity (DUPLICATE_IDENTITY), such as a restarted Notetaker. */
  onReplaced?(): void;
};

export type MediaSession = { leave(): Promise<void> };

export type JoinMedia = (url: string, token: string, handlers: AudioHandlers) => Promise<MediaSession>;

export const joinLiveKit: JoinMedia = async (url, token, handlers) => {
  const room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO || publication.source !== TrackSource.SOURCE_MICROPHONE) return;
    // Identities name one join, `<member>.<participation>`. Audio is cut per join, so a member on
    // two devices isn't mixed into one stream; the Notetaker maps it to the member for each line.
    const speakerId = participant.identity;
    const stream = new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: 1 });
    void (async () => {
      try {
        for await (const frame of stream) {
          const ms = (frame.samplesPerChannel / frame.sampleRate) * 1000;
          handlers.onAudio(speakerId, frame.data, Date.now() - ms);
        }
      } finally {
        handlers.onSpeakerGone(speakerId);
      }
    })();
  });
  let leaving = false;
  room.on(RoomEvent.Disconnected, (reason) => {
    if (leaving) return;
    if (reason === DisconnectReason.DUPLICATE_IDENTITY) handlers.onReplaced?.();
    else handlers.onDisconnected?.();
  });
  await room.connect(url, token, { autoSubscribe: true, dynacast: false });
  return {
    leave: async () => {
      leaving = true;
      await room.disconnect();
    },
  };
};
