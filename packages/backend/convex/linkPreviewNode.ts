"use node";
/**
 * Fetches link previews (spec #63) in Convex's Node.js runtime, so every request goes through
 * guardedFetch: the socket checks the address it connects to, after lib/linkPreview.ts has checked
 * the URL and its addresses before the request and after each redirect.
 */
import dns from "node:dns";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { guardedFetch } from "./lib/a2a/guardedFetch";
import { fetchLinkPreview, previewLimits, previewNetOverride, type PreviewNet } from "./lib/linkPreview";

const realNet: PreviewNet = {
  resolve: async (hostname) =>
    (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address),
  get: async (url, init) => {
    const response = await guardedFetch(
      url,
      { method: "GET", headers: init.headers, signal: init.signal },
      { allowHttp: true, strict: true },
    );
    return { status: response.status, headers: response.headers, body: response.body };
  },
};

export const fetchPreview = internalAction({
  // The team that asked: if it, and every team waiting on the same link, turns previews off before
  // or during the fetch, nothing more is fetched.
  args: { url: v.string(), teamId: v.id("teams") },
  handler: async (ctx, { url, teamId }) => {
    const stillOn = () => ctx.runQuery(internal.linkPreviews.stillOn, { teamId, url });
    const result = await fetchLinkPreview(url, previewNetOverride() ?? realNet, previewLimits(), stillOn);
    if (!result.ok && result.turnedOff) {
      await ctx.runMutation(internal.linkPreviews.abandon, { url });
      return null;
    }
    if (!result.ok) {
      await ctx.runMutation(internal.linkPreviews.settle, { url, error: result.error });
      return null;
    }
    const imageStorageId = result.image
      ? await ctx.storage.store(new Blob([result.image.bytes], { type: result.image.type }))
      : undefined;
    await ctx.runMutation(internal.linkPreviews.settle, {
      url,
      ...(result.meta.title ? { title: result.meta.title } : {}),
      ...(result.meta.description ? { description: result.meta.description } : {}),
      ...(result.meta.siteName ? { siteName: result.meta.siteName } : {}),
      ...(imageStorageId ? { imageStorageId } : {}),
      ...(result.imageError ? { error: `image: ${result.imageError}` } : {}),
    });
    return null;
  },
});
