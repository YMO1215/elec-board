// Month calendar with the 3조 2교대 (주주야야비비) schedule in each person's colour.
import { h } from "./dom.js";
import { SHIFT_KEY, SHIFT_LABEL, SHIFT_PEOPLE, monthGrid, shiftOn } from "./shift.js";

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

function weekdayOf(iso) {
  return WEEK[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

export function openCalendar({ people, today }) {
  let [year, month] = today.split("-").map(Number);
  let selected = today;
  const nameOf = (id) => people.find((p) => p.id === id)?.name ?? id;
  const shiftsOf = (iso) => SHIFT_PEOPLE.map((id) => ({ id, name: nameOf(id), shift: shiftOn(id, iso) }));
  const describe = (iso) => shiftsOf(iso).map((s) => `${s.name} ${SHIFT_LABEL[s.shift]}`).join(", ");

  const dialog = h("dialog", { class: "cal", "aria-label": "근무 일정 달력" });
  const detail = h("div", { class: "cal-detail", "aria-live": "polite" });
  const dayButtons = new Map();

  function paintDetail() {
    const [, m, d] = selected.split("-").map(Number);
    detail.replaceChildren(
      h("p", { class: "cal-detail-title" }, `${m}월 ${d}일 ${weekdayOf(selected)}요일`),
      ...shiftsOf(selected).map((s) => h("p", { class: `cal-line ${s.id}` },
        h("span", { class: "dot", "aria-hidden": "true" }), h("span", { class: "cal-who" }, s.name),
        h("span", { class: `chip s-${SHIFT_KEY[s.shift]}` }, s.shift), h("span", { class: "cal-what" }, SHIFT_LABEL[s.shift]))));
    for (const [iso, btn] of dayButtons) btn.setAttribute("aria-pressed", String(iso === selected));
  }

  function select(iso) {
    selected = iso;
    paintDetail();
  }

  function dayCell(cell) {
    if (!cell.inMonth) return h("span", { class: "day-blank", "aria-hidden": "true" });
    const d = Number(cell.iso.slice(8));
    const btn = h("button", {
      class: `day${cell.iso === today ? " is-today" : ""}`, type: "button", "aria-pressed": "false",
      "aria-label": `${month}월 ${d}일 ${weekdayOf(cell.iso)}요일${cell.iso === today ? " 오늘" : ""}: ${describe(cell.iso)}`,
      dataset: { iso: cell.iso },
      onClick: () => select(cell.iso),
    },
    h("span", { class: "num" }, String(d)),
    h("span", { class: "chips", "aria-hidden": "true" }, shiftsOf(cell.iso).map((s) =>
      h("span", { class: `chip ${s.id} s-${SHIFT_KEY[s.shift]}` }, s.shift))));
    dayButtons.set(cell.iso, btn);
    return btn;
  }

  function draw(focus = null) {
    dayButtons.clear();
    const grid = h("div", { class: "cal-grid", role: "group", "aria-label": `${year}년 ${month}월` },
      monthGrid(year, month).flat().map(dayCell));
    grid.addEventListener("keydown", (e) => {
      const list = [...grid.querySelectorAll(".day")];
      const at = list.indexOf(document.activeElement);
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (at === -1 || step === undefined) return;
      const next = list[at + step];
      if (next) { e.preventDefault(); next.focus(); }
    });
    const nav = (delta) => {
      month += delta;
      if (month < 1) { month = 12; year -= 1; }
      if (month > 12) { month = 1; year += 1; }
      draw(delta < 0 ? "prev" : "next");
    };
    dialog.replaceChildren(h("div", { class: "cal-inner" },
      h("header", { class: "cal-head" },
        h("h2", { class: "cal-title" }, `${year}년 ${month}월`),
        h("button", { class: "cal-today", type: "button", onClick: () => { [year, month] = today.split("-").map(Number); selected = today; draw("today"); } }, "오늘"),
        h("button", { class: "cal-btn", type: "button", "aria-label": "이전 달", dataset: { nav: "prev" }, onClick: () => nav(-1) }, "‹"),
        h("button", { class: "cal-btn", type: "button", "aria-label": "다음 달", dataset: { nav: "next" }, onClick: () => nav(1) }, "›"),
        h("button", { class: "cal-btn", type: "button", "aria-label": "닫기", onClick: () => dialog.close() }, "✕")),
      h("div", { class: "cal-weekdays", "aria-hidden": "true" }, WEEK.map((w) => h("span", {}, w))),
      grid,
      detail,
      h("p", { class: "cal-legend" }, "주간 · 야간 · 비번 — 주주야야비비 3조 2교대, 담당자 색으로 표시")));
    paintDetail();
    if (focus === "prev" || focus === "next") dialog.querySelector(`[data-nav="${focus}"]`)?.focus();
    else if (focus === "today") dayButtons.get(today)?.focus();
  }

  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  draw();
  dialog.showModal();
  (dayButtons.get(selected) ?? dialog.querySelector(".day"))?.focus();
  return dialog;
}
