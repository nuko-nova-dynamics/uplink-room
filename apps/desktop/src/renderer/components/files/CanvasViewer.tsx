import { useEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  reconcileElements,
  restoreElements,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import "./files.css";
import { PinMarker } from "./PinMarker";
import type { ViewerPins } from "./pins";
import { MAX_ELEMENT_BYTES } from "@uplink-room/backend/files";
import {
  canvasSaver,
  canvasStash,
  freshRemote,
  type CanvasAttempt,
  type ShapeVersion,
} from "./sync";

/**
 * A canvas (ADR 0010). Shapes are saved one by one and the Room API keeps the
 * newer edit of each, so several people and agents can draw at once: this view
 * sends only the shapes whose version changed, keeping them until the room has
 * them (see canvasSaver), and merges everyone else's with Excalidraw's own
 * `reconcileElements`. Unsaved shapes are also kept on this computer, so shapes no
 * save reached before the canvas closed are saved when it next opens. Embedded web
 * pages and images are off.
 */
// Fonts come from the app (electron.vite.config.ts), not Excalidraw's CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw/";

type Element = Parameters<typeof restoreElements>[0] extends readonly (infer E)[] | null | undefined
  ? E
  : never;
type Remote = Parameters<typeof reconcileElements>[1];
type Scene = ReturnType<ExcalidrawImperativeAPI["getSceneElementsIncludingDeleted"]>;

const UI_OPTIONS = {
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    export: false as const,
    toggleTheme: null,
    saveAsImage: true,
  },
  tools: { image: false },
};

type Shape = Record<string, unknown> & { id: string } & ShapeVersion;

function useTheme(): "dark" | "light" {
  const read = (): "dark" | "light" =>
    document.documentElement.dataset["theme"] === "light" ? "light" : "dark";
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

const storage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
  removeItem: (key: string) => localStorage.removeItem(key),
};

export default function CanvasViewer({
  fileId,
  elements,
  onSave,
  onRejected,
  pins,
  selected,
  draft,
  placing,
  onPlace,
  onSelect,
}: ViewerPins & {
  fileId: string;
  /** Every shape from `canvas.scene`, deleted ones included. */
  elements: Record<string, unknown>[];
  /** Saves a batch of shapes and says how it went. */
  onSave: (elements: Record<string, unknown>[]) => Promise<CanvasAttempt>;
  /** Tells the person a shape couldn't be saved. */
  onRejected: (message: string) => void;
}) {
  const theme = useTheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [view, setView] = useState<Pick<
    AppState,
    "scrollX" | "scrollY" | "zoom" | "offsetLeft" | "offsetTop"
  > | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSave, onRejected });
  callbacks.current = { onSave, onRejected };
  /** Unsaved shapes and the versions the room has; a shape counts as saved only once a save succeeds. */
  const [saver] = useState(() =>
    canvasSaver({
      save: (batch) => callbacks.current.onSave(batch),
      onRejected: (message) => callbacks.current.onRejected(message),
      maxBytes: MAX_ELEMENT_BYTES,
      stash: canvasStash(storage, fileId),
    }),
  );
  const [initialData] = useState(() => {
    saver.confirm(elements as Shape[]);
    // Shapes from an earlier session here that never reached the room: shown, and saved again.
    const byId = new Map((elements as Shape[]).map((e) => [e.id, e]));
    for (const shape of saver.restore()) byId.set(shape.id, shape);
    return {
      // No re-measuring here: text measured before Excalifont loads comes out too narrow and clips.
      elements: restoreElements([...byId.values()] as unknown as Element[], null, {
        repairBindings: true,
      }),
      appState: { viewBackgroundColor: "transparent" },
      scrollToContent: true,
    };
  });

  // Open on everything that's drawn, sized to the view, once the canvas has its size.
  useEffect(() => {
    if (!api) return;
    const frame = requestAnimationFrame(() => {
      const shapes = api.getSceneElements();
      if (shapes.length)
        api.scrollToContent(shapes, {
          fitToViewport: true,
          viewportZoomFactor: 0.8,
          animate: false,
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [api]);

  // Everyone else's edits: merge them in without undoing the person's own.
  useEffect(() => {
    if (!api) return;
    // Newer shapes, and ties another editor won in the room, which this viewer must adopt.
    const fresh = freshRemote(saver.confirmed, elements as Shape[]);
    if (fresh.length === 0) return;
    saver.confirm(fresh);
    const restored = restoreElements(fresh as unknown as Element[], null);
    const merged = reconcileElements(
      api.getSceneElementsIncludingDeleted(),
      restored as unknown as Remote,
      api.getAppState(),
    );
    api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
  }, [api, elements, saver]);

  // Leaving the canvas sends what's pending at once; a failed send keeps retrying for a while.
  // In development, StrictMode runs this cleanup and the setup again on mount, so the setup
  // reactivates the saver.
  useEffect(() => {
    saver.resume();
    return () => saver.dispose();
  }, [saver]);

  const onChange = (scene: Scene, appState: AppState) => {
    // Excalidraw calls onChange on every render; only a real move of the view is state.
    setView((prev) =>
      prev &&
      prev.scrollX === appState.scrollX &&
      prev.scrollY === appState.scrollY &&
      prev.zoom.value === appState.zoom.value &&
      prev.offsetLeft === appState.offsetLeft &&
      prev.offsetTop === appState.offsetTop
        ? prev
        : {
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
            zoom: appState.zoom,
            offsetLeft: appState.offsetLeft,
            offsetTop: appState.offsetTop,
          },
    );
    saver.changed(scene as unknown as Shape[]);
  };

  const toViewport = (x: number, y: number) => {
    if (!view) return null;
    const box = host.current?.getBoundingClientRect();
    const at = sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, view as AppState);
    return { x: at.x - (box?.left ?? 0), y: at.y - (box?.top ?? 0) };
  };

  return (
    <div className="canvas-viewer" ref={host}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        theme={theme}
        onChange={(scene, appState) => onChange(scene as Scene, appState)}
        validateEmbeddable={false}
        UIOptions={UI_OPTIONS}
      />
      <div
        className={`canvas-pins ${placing ? "placing" : ""}`}
        role="group"
        aria-label="Canvas comment pins"
        tabIndex={placing ? 0 : undefined}
        onKeyDown={(event) => {
          if (
            !placing ||
            !view ||
            event.target !== event.currentTarget ||
            !["Enter", " "].includes(event.key)
          )
            return;
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          const at = viewportCoordsToSceneCoords(
            { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 },
            view as AppState,
          );
          onPlace({ kind: "point", x: Math.round(at.x), y: Math.round(at.y) });
        }}
        onClick={(event) => {
          if (!placing || !view) return;
          const at = viewportCoordsToSceneCoords(
            { clientX: event.clientX, clientY: event.clientY },
            view as AppState,
          );
          onPlace({ kind: "point", x: Math.round(at.x), y: Math.round(at.y) });
        }}
      >
        {pins.map((p) => {
          if (p.pin.kind !== "point") return null;
          const at = toViewport(p.pin.x, p.pin.y);
          return at ? (
            <PinMarker
              key={p.commentId}
              label={String(p.n)}
              x={at.x}
              y={at.y}
              unit="px"
              selected={p.commentId === selected}
              onClick={() => onSelect(p.commentId)}
            />
          ) : null;
        })}
        {draft?.kind === "point"
          ? (() => {
              const at = toViewport(draft.x, draft.y);
              return at ? <PinMarker label="+" x={at.x} y={at.y} unit="px" draft /> : null;
            })()
          : null}
      </div>
    </div>
  );
}
