import { createContext } from "react";

/**
 * True while Settings covers the view you were on (Shell keeps that view mounted under it). A view
 * that marks what you've read holds off until it's uncovered, so what arrives meanwhile stays unread.
 */
export const Covered = createContext(false);
