// One rounded SVG icon set (stroke 2, round caps/joins) so every glyph has the same weight.
const NS = "http://www.w3.org/2000/svg";

const PATHS = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  plus: "M12 5v14M5 12h14",
  "chevron-down": "M6.5 9.5L12 15l5.5-5.5",
  "chevron-left": "M14.5 6.5L9 12l5.5 5.5",
  "chevron-right": "M9.5 6.5L15 12l-5.5 5.5",
  // two opposing arrows: "move to another lane"
  move: "M4 8.5h13M13.5 5l3.5 3.5-3.5 3.5M20 15.5H7M10.5 12l-3.5 3.5 3.5 3.5",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5h9.2L17.5 7M10.2 11v5M13.8 11v5",
  comment: "M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5V16h-1A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5z",
  "arrow-up": "M12 18.5V6M6.5 11.5L12 6l5.5 5.5",
  restore: "M5 12a7 7 0 1 0 2.1-5M5 4.5V9h4.5",
};

/** Returns a new decorative <svg>. Give the button that holds it an aria-label. */
export function icon(name, size = 18) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon", `icon-${name}`);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}

export const ICON_NAMES = Object.keys(PATHS);
