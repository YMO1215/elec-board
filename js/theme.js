// Manual light/dark choice. Nothing chosen = follow the OS (css handles that via prefers-color-scheme).
// A choice is written to <html data-theme> and remembered in localStorage; index.html applies the saved
// one before first paint (inline script) so the page does not flash the wrong theme.
import { icon } from "./icons.js";

export const THEME_KEY = "board-theme";
const BAR = { light: "#f5f5f7", dark: "#000000" }; // = the two <meta name="theme-color"> values

const osDark = () => window.matchMedia("(prefers-color-scheme: dark)");

function saved() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** The theme actually on screen: explicit choice first, otherwise the OS. */
export function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return osDark().matches ? "dark" : "light";
}

function syncBarColor(theme) {
  // Manual choice overrides the media-conditional metas with one value; with no choice they stay as authored.
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", BAR[theme]);
}

export function initThemeToggle(btn) {
  const paint = () => {
    const now = effectiveTheme();
    // Show where a press goes: in the dark the button is a sun, in the light a moon.
    btn.replaceChildren(icon(now === "dark" ? "sun" : "moon", 18));
    const label = now === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  };
  const saveChoice = saved();
  if (saveChoice) {
    document.documentElement.dataset.theme = saveChoice;
    syncBarColor(saveChoice);
  }
  paint();
  btn.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: the choice just lasts until reload */
    }
    syncBarColor(next);
    paint();
  });
  // No explicit choice yet -> the icon follows the OS when it flips.
  osDark().addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) paint();
  });
}
