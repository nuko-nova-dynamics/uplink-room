/** Hex SHA-256 of a secret. Secrets are stored only as hashes. */
export async function sha256(secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A random secret with a readable prefix, such as `urk_…` for agent keys. */
export function randomSecret(prefix: string, bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  const body = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${body}`;
}

/** A short pairing code a person can type, such as `K7QX-2MPD`. */
export function pairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...raw].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
