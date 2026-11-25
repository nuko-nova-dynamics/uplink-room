/**
 * LiveKit for calls (ADR 0007). The backend holds LiveKit's API key and
 * secret; people and agents only ever get a token for one call's room.
 */
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { Id } from "../_generated/dataModel";
import { roomError } from "./errors";

export type LiveKitConfig = { url: string; apiKey: string; apiSecret: string };

/** LiveKit's settings from the deployment's environment, or null when calls aren't set up. */
export function liveKitConfig(): LiveKitConfig | null {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

export function requireLiveKit(): LiveKitConfig {
  const config = liveKitConfig();
  if (!config) {
    throw roomError(
      "invalid",
      "Calls aren't set up on this deployment: LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are needed.",
    );
  }
  return config;
}

/** The LiveKit room for a call. Opaque, since LiveKit logs room names. */
export function roomName(callId: Id<"calls">): string {
  return `call_${callId}`;
}

export function callIdFromRoom(name: string): string | null {
  return name.startsWith("call_") ? name.slice("call_".length) : null;
}

/**
 * The LiveKit identity of one join: `<member id>.<participation id>`. One per
 * join, so a member on two devices doesn't knock the other out of the room
 * (LiveKit disconnects a duplicate identity). Clients take the member id from
 * the part before the dot.
 */
export function liveKitIdentity(memberId: Id<"members">, participationId: Id<"callParticipations">): string {
  return `${memberId}.${participationId}`;
}

export function parseIdentity(identity: string): { memberId: string; participationId: string } | null {
  const dot = identity.indexOf(".");
  if (dot <= 0 || dot === identity.length - 1) return null;
  return { memberId: identity.slice(0, dot), participationId: identity.slice(dot + 1) };
}

/** A token's life. LiveKit refreshes tokens for connected clients, so this only bounds the first connection. */
export const TOKEN_TTL_SECONDS = 10 * 60;

/**
 * A token for one join of a call. The identity names the join (liveKitIdentity)
 * and there is no name (LiveKit logs both); the app maps identities to members. People may
 * publish a microphone, a camera and a screen with its sound; agents only a
 * microphone, so an agent's tile is always its character.
 */
export async function joinToken(
  config: LiveKitConfig,
  callId: Id<"calls">,
  memberId: Id<"members">,
  participationId: Id<"callParticipations">,
  kind: "person" | "agent",
): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: liveKitIdentity(memberId, participationId),
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant({
    room: roomName(callId),
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    canPublishSources:
      kind === "person"
        ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
        : [TrackSource.MICROPHONE],
  });
  return await token.toJwt();
}

/**
 * LiveKit's room service, for taking someone out of a call: `RemoveParticipant` disconnects that
 * join, and `revokeTokenTs` makes LiveKit refuse that identity's tokens issued before it, so a
 * token minted just before the removal can't rejoin (docs.livekit.io, Room service API). The
 * timestamp is in seconds and must be within 60 seconds of LiveKit's clock, so each try passes
 * the time it is made. It needs the `roomAdmin` grant, which the server SDK signs with the API key
 * and secret.
 *
 * Resolves "removed" when LiveKit took the join out, or "absent" when it says the participant
 * doesn't exist (it had left; LiveKit still revokes the token). Anything else (a timeout, a 5xx,
 * no network) throws, and the caller tries again later.
 */
export type LiveKitRooms = {
  removeParticipant(room: string, identity: string, revokeBeforeMs: number): Promise<"removed" | "absent">;
};

/** LiveKit's Twirp "not_found" (HTTP 404): the participant isn't in the room. */
export function isNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null;
  return e?.code === "not_found" || e?.status === 404;
}

let roomsOverride: LiveKitRooms | undefined;

/** Tests swap in a fake; `undefined` goes back to LiveKit's own server API. */
export function setLiveKitRoomsForTests(rooms: LiveKitRooms | undefined): void {
  roomsOverride = rooms;
}

export function liveKitRooms(config: LiveKitConfig): LiveKitRooms {
  if (roomsOverride) return roomsOverride;
  // The server API is served over http(s) at the same host the clients reach over ws(s).
  const host = config.url.replace(/^ws(s?):\/\//, "http$1://");
  const client = new RoomServiceClient(host, config.apiKey, config.apiSecret);
  return {
    removeParticipant: async (room, identity, revokeBeforeMs) => {
      try {
        await client.removeParticipant(room, identity, { revokeTokenTs: BigInt(Math.floor(revokeBeforeMs / 1000)) });
        return "removed";
      } catch (error) {
        if (isNotFound(error)) return "absent";
        throw error;
      }
    },
  };
}
