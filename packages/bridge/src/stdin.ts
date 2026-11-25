/**
 * Reads a stream to its end as UTF-8 text, decoding the bytes once, so a character split between two
 * chunks comes through whole (`uplink-bridge say` and `reply` read a message's text this way).
 */
export async function readStdin(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
