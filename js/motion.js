// Motion helpers. Every effect is skipped when the user asks for reduced motion,
// so no behaviour ever waits on an animation that will not run.
export const EASE = "cubic-bezier(.32,.72,0,1)";

export const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Restart a one-shot CSS animation class. */
export function replay(el, cls) {
  if (!el || reduced()) return;
  el.classList.remove(cls);
  void el.offsetWidth; // reflow so the animation starts again
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

/** Close a <dialog> with its exit animation (scale / slide down) instead of vanishing. */
export function animateClose(dialog) {
  if (!dialog.open || dialog.classList.contains("is-closing")) return;
  if (reduced()) {
    dialog.close();
    return;
  }
  dialog.classList.add("is-closing");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    dialog.classList.remove("is-closing");
    if (dialog.open) dialog.close();
  };
  dialog.addEventListener("animationend", function onEnd(e) {
    if (e.target !== dialog) return; // ignore animations of children
    dialog.removeEventListener("animationend", onEnd);
    finish();
  });
  setTimeout(finish, 360); // safety net
}

/** Esc and backdrop taps close with the animation too. */
export function wireDialog(dialog) {
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    animateClose(dialog);
  });
  dialog.addEventListener("click", (e) => { if (e.target === dialog) animateClose(dialog); });
}

/** Height open/close for a disclosure panel. `show` true = open. */
export function toggleHeight(panel, show, onHidden) {
  if (reduced()) {
    panel.hidden = !show;
    if (!show) onHidden?.();
    return;
  }
  panel.getAnimations().forEach((a) => a.cancel());
  panel.style.overflow = "hidden";
  const clear = () => { panel.style.overflow = ""; };
  if (show) {
    panel.hidden = false;
    const cs = getComputedStyle(panel);
    const a = panel.animate([
      { height: "0px", paddingTop: "0px", marginTop: "0px", borderTopWidth: "0px", opacity: 0 },
      { height: `${panel.scrollHeight}px`, paddingTop: cs.paddingTop, marginTop: cs.marginTop, borderTopWidth: cs.borderTopWidth, opacity: 1 },
    ], { duration: 320, easing: EASE });
    a.onfinish = clear;
    a.oncancel = clear;
  } else {
    const a = panel.animate([
      { height: `${panel.offsetHeight}px`, opacity: 1 },
      { height: "0px", paddingTop: "0px", marginTop: "0px", borderTopWidth: "0px", opacity: 0 },
    ], { duration: 240, easing: EASE });
    a.onfinish = () => { panel.hidden = true; clear(); onHidden?.(); };
    a.oncancel = clear;
  }
}
