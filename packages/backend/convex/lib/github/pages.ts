/**
 * The pages a person sees in their browser while connecting a GitHub account (ADR 0020), served
 * by `githubHttp.ts`. Each says what happened and what to do next, in the app's tokens
 * (DESIGN.md), light or dark as the browser is set. They run no script, post no form, and load only
 * the app's font and GitHub avatars. The last one says to return to Uplink Room, where the person
 * who started the connect confirms it.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root{--ground:#f7f8fa;--raised:#fff;--line:#dfe2e7;--text:#15171a;--muted:#5b6069;--amber-text:#9a5b00;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--ground:#121315;--raised:#18191c;--line:#26282c;--text:#ebecee;--muted:#8f939b;--amber-text:#f0a73a;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--ground);color:var(--text)}
body{font:15px/1.55 "Atkinson Hyperlegible Next",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:40px 20px}
::selection{background:var(--text);color:var(--ground)}
main{max-width:480px;margin:0 auto}
.brand{font-size:13px;font-weight:700;color:var(--muted);margin:0 0 40px}
h1{font-size:24px;line-height:1.25;margin:0 0 12px;font-weight:700;text-wrap:balance}
p{margin:0 0 14px;color:var(--muted);max-width:62ch;text-wrap:pretty}
p strong{color:var(--text);font-weight:700}
.accounts{list-style:none;margin:24px 0 0;padding:0;border:1px solid var(--line);border-radius:10px;background:var(--raised)}
.accounts li{display:flex;align-items:center;gap:12px;padding:12px 14px}
.accounts li+li{border-top:1px solid var(--line)}
.accounts img,.initial{width:32px;height:32px;flex:none;border:1px solid var(--line);background:var(--ground)}
.initial{display:grid;place-items:center;font-weight:700;color:var(--muted)}
.org{border-radius:7px}.user{border-radius:50%}
.who{flex:1;min-width:0}
.who b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who span{font-size:13px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:7px;border:1px solid var(--line);background:var(--raised);color:var(--text);font:inherit;font-size:14px;font-weight:700;text-decoration:none;cursor:pointer;white-space:nowrap}
.btn.primary{background:var(--text);border-color:var(--text);color:var(--ground)}
.btn:hover{border-color:var(--muted)}
.btn:focus-visible,a:focus-visible{outline:2px solid var(--text);outline-offset:2px}
.done{font-size:13px;color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}
.warn{color:var(--amber-text)}
a{color:var(--text);text-underline-offset:3px}
@media (min-width:480px){.name{white-space:nowrap}}
`;

/** Security headers for every page: no scripts, no framing, no referrer (the URL holds the flow's state). */
export const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https://avatars.githubusercontent.com; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};

/** A GitHub login in a heading: kept on one line where there's room, so `nuko-nova-dynamics` doesn't break at a hyphen. */
export function login(name: string): string {
  return `<span class="name">${escapeHtml(name)}</span>`;
}

/** A page: a heading and paragraphs (both already HTML), and optional extra HTML below them. */
export function page(opts: { title: string; heading: string; paragraphs: string[]; extra?: string; status?: number }): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Uplink Room: ${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;700&amp;display=swap">
<style>${STYLE}</style></head>
<body><main>
<p class="brand">Uplink Room</p>
<h1>${opts.heading}</h1>
${opts.paragraphs.map((p) => `<p>${p}</p>`).join("\n")}
${opts.extra ?? ""}
</main></body></html>`;
  return new Response(html, { status: opts.status ?? 200, headers: PAGE_HEADERS });
}

export type AccountChoice = {
  installationId: number;
  login: string;
  type: "Organization" | "User";
  avatarUrl?: string;
  repositorySelection: "all" | "selected";
  suspended: boolean;
  connected: boolean;
  /**
   * Whether it may be connected from this flow: the GitHub user's own personal account, or an
   * organization they own on GitHub when a team admin started the flow.
   */
  canShare: boolean;
  /**
   * Why not: `owner`, they don't own the organization on GitHub; `admin`, only a team admin connects
   * organizations; `self`, someone else's personal account; `limit`, an organization past the ones checked.
   */
  refusal?: "owner" | "admin" | "self" | "limit";
};

const REFUSED: Record<NonNullable<AccountChoice["refusal"]>, string> = {
  owner: "Owners only",
  admin: "Team admins only",
  self: "Not your account",
  limit: "Not checked",
};

function avatar(choice: AccountChoice): string {
  const kind = choice.type === "Organization" ? "org" : "user";
  return choice.avatarUrl?.startsWith("https://avatars.githubusercontent.com/")
    ? `<img class="${kind}" src="${escapeHtml(choice.avatarUrl)}" alt="">`
    : `<span class="initial ${kind}" aria-hidden="true">${escapeHtml(choice.login.slice(0, 1).toUpperCase())}</span>`;
}

function describe(choice: AccountChoice): string {
  const kind = choice.type === "Organization" ? "Organization" : "Personal account";
  const repos = choice.repositorySelection === "all" ? "all repos" : "selected repos";
  return choice.suspended ? `${kind}, suspended on GitHub` : `${kind}, ${repos}`;
}

/**
 * The accounts GitHub listed, read-only, each with why it can't be connected from this link. No
 * page links anything: the person who started the connect confirms in the app.
 */
export function accountList(choices: AccountChoice[]): string {
  const rows = choices.map((c) => {
    const status = c.connected
      ? "Connected"
      : !c.canShare
        ? REFUSED[c.refusal ?? (c.type === "Organization" ? "owner" : "self")]
        : "Confirm in Uplink Room";
    return `<li>${avatar(c)}<div class="who"><b>${escapeHtml(c.login)}</b><span>${escapeHtml(describe(c))}</span></div><span class="done">${status}</span></li>`;
  });
  return `<ul class="accounts">${rows.join("")}</ul>`;
}

export function actions(links: { href: string; label: string; primary?: boolean }[]): string {
  return `<div class="actions">${links
    .map((l) => `<a class="btn${l.primary ? " primary" : ""}" href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`)
    .join("")}</div>`;
}
