import type { Theme } from "./theme";

/**
 * Clerk's sign-in card and user menu in the app's own colors and type, for
 * either theme (DESIGN.md, Color and Type). Clerk derives its shades from
 * these, so they are the tokens' hex values, not CSS variables. Variable
 * names are @clerk/react 6's `appearance.variables`.
 */
const UI_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Atkinson Hyperlegible Next", sans-serif';

const DARK = {
  colorPrimary: "#EBECEE",
  colorPrimaryForeground: "#121315",
  colorBackground: "#18191C",
  colorForeground: "#EBECEE",
  colorMuted: "#1D1F22",
  colorMutedForeground: "#8F939B",
  colorNeutral: "#EBECEE",
  colorInput: "#0F1012",
  colorInputForeground: "#EBECEE",
  colorBorder: "#26282C",
  colorRing: "#F0A73A",
  colorShadow: "#000000",
  colorDanger: "#EF6F6C",
  colorSuccess: "#5FC38F",
  colorWarning: "#F0A73A",
};

const LIGHT = {
  colorPrimary: "#15171A",
  colorPrimaryForeground: "#F7F8FA",
  colorBackground: "#FFFFFF",
  colorForeground: "#15171A",
  colorMuted: "#EEF0F3",
  colorMutedForeground: "#5B6069",
  colorNeutral: "#15171A",
  // The ground color, so a field reads on the white card.
  colorInput: "#F7F8FA",
  colorInputForeground: "#15171A",
  colorBorder: "#DFE2E7",
  colorRing: "#F0A73A",
  colorShadow: "#14181E",
  colorDanger: "#C4413E",
  colorSuccess: "#117A49",
  colorWarning: "#9A5B00",
};

export function clerkAppearance(theme: Theme) {
  return {
    variables: {
      ...(theme === "light" ? LIGHT : DARK),
      fontFamily: UI_FONT,
      fontFamilyButtons: UI_FONT,
      fontSize: "13px",
      borderRadius: "7px",
    },
  };
}
