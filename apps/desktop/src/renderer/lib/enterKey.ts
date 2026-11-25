/**
 * Whether the Enter key is down, from the window's own key events (capture phase, so before any
 * element's handler), and a latch for "this press already did something".
 *
 * After Enter picks something (a mention, an emoji in the picker), the same press, held, must not
 * also send the draft: `latchEnter()` holds Enter back until that key is let go. It arms only while
 * Enter is actually down, so a pick made with Space or Tab never swallows the next Enter.
 */
let enterDown = false;
let latched = false;

if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter") enterDown = true;
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (event) => {
      if (event.key !== "Enter") return;
      enterDown = false;
      latched = false;
    },
    true,
  );
  // A key let go in another window never reaches this one.
  window.addEventListener("blur", () => {
    enterDown = false;
    latched = false;
  });
}

/** Holds Enter back until it's let go, if it's down now; otherwise does nothing. */
export function latchEnter() {
  if (enterDown) latched = true;
}

/** Whether Enter is held back: it picked something and hasn't been let go since. */
export function enterLatched() {
  return latched;
}
