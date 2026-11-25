import { api } from "../../lib/api";
import { useAct, useRoomQuery, useSession } from "../../lib/session";
import { OnOff } from "./Notifications";

/**
 * The team's chat settings (spec #63). Link previews: the room fetches the pages messages link to,
 * never the app, under strict rules (ADR 0015). Admins can turn that off for the whole team.
 */
export function Chat() {
  const session = useSession();
  const settings = useRoomQuery(api.teams.settings, {});
  const set = useAct(api.teams.setLinkPreviews, { success: "Saved." });
  const on = settings?.linkPreviews !== "off";
  return (
    <div className="chat-settings">
      <div className="pane-title">
        <h2>Chat</h2>
      </div>
      <div className="panel">
        <div className="panel-section">
          <div className="settings-copy">
            <span className="label" id="previews-label">
              Link previews
            </span>
            <OnOff
              labelledBy="previews-label"
              on={on}
              disabled={!session.isAdmin || !settings}
              onChange={(value) => void set({ linkPreviews: value ? "on" : "off" })}
            />
            <span className="hint">
              A link in a message shows the page's title, description and image. The room fetches
              them, never your app, so a link can't learn your address or run anything here. It only
              fetches public pages, at most 1 MB within 5 seconds, and keeps a copy of the image.
              Off, it fetches nothing and messages show no previews.
            </span>
            {session.isAdmin ? null : <span className="hint">Only admins can change this.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
