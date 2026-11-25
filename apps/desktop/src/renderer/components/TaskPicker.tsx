import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  createMenuController,
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
} from "@ui-sdk/react/menu";
import { api, type Id, type TaskCard } from "../lib/api";
import { runLabel } from "../lib/format";
import { useRoomQuery } from "../lib/session";
import { Icon } from "./Icon";

export type TaskOrRun =
  | { kind: "task"; id: Id<"tasks">; label: string }
  | { kind: "run"; id: Id<"runs">; label: string };

/** Renders a menu item as a native button, so the app's `.pop button` and composer rows style it. */
const asButton = (props: Record<string, unknown>) => <button type="button" {...props} />;

/**
 * Where the menu opens. A caller that places it in the window (`style` with `left`, and `top` or
 * `bottom`, as `placeNear` gives) gets that point; otherwise it opens above the element it's
 * rendered in, as the composer's menus do.
 */
function placement(style: CSSProperties | undefined) {
  const left = typeof style?.left === "number" ? style.left : undefined;
  if (left !== undefined && typeof style?.top === "number")
    return { point: { x: left, y: style.top }, side: "bottom" as const, offset: 0 };
  if (left !== undefined && typeof style?.bottom === "number")
    return {
      point: { x: left, y: window.innerHeight - style.bottom },
      side: "top" as const,
      offset: 0,
    };
  return { point: undefined, side: "top" as const, offset: 6 };
}

/**
 * The team's open tasks as a menu (tasks.board): the composer's "Mention a task or run", with each
 * task's runs under it, and a roster agent's "Give it a task", tasks only (`runs` false). It's a
 * UI SDK Menu, open while it's rendered: Escape, a press outside or Tab close it through `onClose`.
 * `focus` puts the keys on its first item when it opens; the arrows, Home, End and typing move
 * through the items.
 */
export function TaskPicker({
  title,
  empty,
  runs = true,
  focus = false,
  className = "",
  style,
  onClose,
  onPick,
}: {
  title: string;
  /** What it says with no open tasks. */
  empty: string;
  runs?: boolean;
  focus?: boolean;
  className?: string;
  style?: CSSProperties;
  onClose: () => void;
  onPick: (item: TaskOrRun, task: TaskCard) => void;
}) {
  const tasks = useRoomQuery(api.tasks.board, {});
  const [menu] = useState(() => createMenuController());
  // Marks where the menu was rendered, so it can open against the element around it.
  const spot = useRef<HTMLSpanElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const { point, side, offset } = placement(style);
  const loaded = tasks !== undefined;
  // Opens on mount, and again once the tasks arrive, so the keys land on the first one.
  useEffect(() => {
    void menu.open({
      anchor: point ?? spot.current?.parentElement ?? undefined,
      focus: focus && loaded ? "first" : "none",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  return (
    <>
      <span ref={spot} hidden />
      <Menu
        controller={menu}
        // A press outside closes it and still reaches what it pressed, as the composer's box.
        modal={false}
        onOpenChange={(open) => {
          if (!open) close.current();
        }}
      >
        <MenuContent
          className={`pop task-picker ${className}`}
          aria-label={title}
          side={side}
          align="start"
          sideOffset={offset}
          collisionPadding={8}
          // The caller decides where focus goes after a pick, such as back to the message box.
          finalFocus="none"
          style={style?.maxHeight !== undefined ? { maxHeight: style.maxHeight } : undefined}
        >
          <MenuGroup>
            <MenuGroupLabel className="pop-title">{title}</MenuGroupLabel>
            {tasks === undefined ? <div className="muted pop-note">Loading tasks</div> : null}
            {tasks?.length === 0 ? <div className="muted pop-note">{empty}</div> : null}
            {(tasks ?? []).map((task) => (
              <Fragment key={task.taskId}>
                <MenuItem
                  render={asButton}
                  label={task.title}
                  onSelect={() =>
                    onPick({ kind: "task", id: task.taskId, label: task.title }, task)
                  }
                >
                  <Icon name="board" /> <span className="truncate">{task.title}</span>
                </MenuItem>
                {runs
                  ? task.runs.map((run) => (
                      <MenuItem
                        key={run.runId}
                        render={asButton}
                        className="sub"
                        label={`${runLabel(run)} run`}
                        onSelect={() =>
                          onPick(
                            { kind: "run", id: run.runId, label: `${runLabel(run)} run` },
                            task,
                          )
                        }
                      >
                        <Icon name="terminal" /> {runLabel(run)} run
                      </MenuItem>
                    ))
                  : null}
              </Fragment>
            ))}
          </MenuGroup>
        </MenuContent>
      </Menu>
    </>
  );
}
