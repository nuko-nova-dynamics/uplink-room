import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { AgentSetup, McpAdded, McpHarness, SkillTarget } from "../../main/agentSetupSpec";
import { desktop } from "./desktop";

/**
 * The uplink skill and uplink-mcp for agents on this computer, as Settings, Command line shows them
 * (main/agentSetup.ts, ADR 0042). The gym provides a simulated one through `AgentSetupContext`.
 */
export type AgentSetupApi = {
  /** Whether the skill is in each harness's folder; null outside the installed app. */
  read: () => Promise<AgentSetup | null>;
  installSkill: (target: SkillTarget) => Promise<AgentSetup>;
  addMcp: (harness: McpHarness) => Promise<McpAdded>;
};

export const desktopAgentSetup: AgentSetupApi = {
  read: async () => (await desktop.agentSetup?.()) ?? null,
  installSkill: async (target) => {
    if (!desktop.installAgentSkill) throw new Error("Only the installed app carries the skill.");
    return desktop.installAgentSkill(target);
  },
  addMcp: async (harness) => {
    if (!desktop.addMcpServer) throw new Error("Only the installed app carries uplink-mcp.");
    return desktop.addMcpServer(harness);
  },
};

export const AgentSetupContext = createContext<AgentSetupApi>(desktopAgentSetup);

export type AgentSetupView = {
  /** Undefined while reading; null outside the installed app. */
  setup: AgentSetup | null | undefined;
  /** The harness whose skill is being installed, or the MCP add running. */
  busy: SkillTarget | "mcp" | null;
  /** The last failure, and which row it belongs to. */
  error: { row: SkillTarget | "mcp"; message: string } | null;
  /** The last MCP server added. */
  added: McpAdded | null;
  installSkill: (target: SkillTarget) => Promise<void>;
  addMcp: (harness: McpHarness) => Promise<void>;
};

const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

/** Reads it when shown and whenever the window comes back to the front; changes it only on a click. */
export function useAgentSetup(): AgentSetupView {
  const api = useContext(AgentSetupContext);
  const [setup, setSetup] = useState<AgentSetup | null | undefined>(undefined);
  const [busy, setBusy] = useState<AgentSetupView["busy"]>(null);
  const [error, setError] = useState<AgentSetupView["error"]>(null);
  const [added, setAdded] = useState<McpAdded | null>(null);
  const live = useRef(true);
  const read = useCallback(() => {
    void api.read().then(
      (next) => live.current && setSetup(next),
      () => live.current && setSetup(null),
    );
  }, [api]);
  useEffect(() => {
    live.current = true;
    read();
    window.addEventListener("focus", read);
    return () => {
      live.current = false;
      window.removeEventListener("focus", read);
    };
  }, [read]);
  const installSkill = useCallback(
    async (target: SkillTarget) => {
      setBusy(target);
      setError(null);
      try {
        const next = await api.installSkill(target);
        if (live.current) setSetup(next);
      } catch (failure) {
        if (live.current) setError({ row: target, message: message(failure) });
      } finally {
        if (live.current) setBusy(null);
      }
    },
    [api],
  );
  const addMcp = useCallback(
    async (harness: McpHarness) => {
      setBusy("mcp");
      setError(null);
      setAdded(null);
      try {
        const done = await api.addMcp(harness);
        if (live.current) setAdded(done);
      } catch (failure) {
        if (live.current) setError({ row: "mcp", message: message(failure) });
      } finally {
        if (live.current) setBusy(null);
      }
    },
    [api],
  );
  return { setup, busy, error, added, installSkill, addMcp };
}
