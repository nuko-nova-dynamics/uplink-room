/** Serves files at local links, as the room's storage serves a message's attachments to a bridge (ADR 0043). */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RoomFile } from "@uplink-room/protocol";

export class FileServer {
  private files = new Map<string, { body: Buffer; type: string }>();
  /** Every path asked for, in order. */
  asked: string[] = [];
  /** How long each answer waits, as a slow link would. */
  delayMs = 0;
  /** While set, every answer waits for it, as a transfer still in progress would. */
  gate?: Promise<unknown>;
  private server = createServer(async (req, res) => {
    this.asked.push(req.url ?? "");
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.gate) await this.gate;
    const file = this.files.get(req.url ?? "");
    if (!file) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": file.type, "content-length": file.body.byteLength });
    res.end(file.body);
  });
  base = "";
  static async start() {
    const files = new FileServer();
    await new Promise<void>((resolve) => files.server.listen(0, "127.0.0.1", resolve));
    files.base = `http://127.0.0.1:${(files.server.address() as AddressInfo).port}`;
    return files;
  }
  /** A file the room would hand over: its bytes are served at a link of their own. */
  add(name: string, body: string | Buffer, mimeType: string, kind: RoomFile["kind"] = mimeType.startsWith("image/") ? "image" : "file"): RoomFile {
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    const path = `/storage/${this.files.size + 1}`;
    this.files.set(path, { body: bytes, type: mimeType });
    return { name, kind, mimeType, size: bytes.byteLength, url: `${this.base}${path}` };
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
