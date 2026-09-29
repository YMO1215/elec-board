// Settings: my account, and (admin) team, sites, assets + QR labels, inspection
// templates, KPI targets/weights; audit log for admin/reviewer. Each fold loads
// its data the first time it is opened; ?open=<key> opens one fold and scrolls to it.
import { api } from "../api.js";
import { fill, h, icon } from "../dom.js";
import { fmtDateTime } from "../lib/format.js";
import { parseHash, rerender, setQuery } from "../router.js";
import { loadReference, store } from "../store.js";
import {
  badge, checkChips, chips, describeError, emptyState, errorState, field, inlineConfirm, loadingState, openSheet,
  personTag, seg, toast,
} from "../ui.js";

const ROLES = ["admin", "worker", "reviewer"];
const ROLE_FALLBACK = { admin: "관리자", worker: "작업자", reviewer: "검토자" };
const BOARD_SLOTS = [1, 2, 3, 4];
const THEME_KEY = "eb-theme";
const ME_CACHE_KEY = "eb-me"; // mirrors app.js ME_CACHE_KEY
const THEMES = [{ value: "auto", label: "자동" }, { value: "light", label: "밝게" }, { value: "dark", label: "어둡게" }];
const PASSWORD_MIN = 8;
const RETENTION = { min: 1, max: 50 };
const RETENTION_DEFAULT = 4;
const SERVICE_LIFE = { min: 1, max: 100 };
const INTERVAL_DAYS = { min: 1, max: 3650 };
const TEMPLATE_LIMITS = { items: 200, section: 40, label: 120 };
const AUDIT_LIMIT = 100;
const DETAIL_MAX = 80;
const WEIGHT_EPS = 1e-6;
const LIFE_TONE = { expired: "danger", soon: "warn" };
const AUDIT_ACTIONS = {
  "org.create": "팀 생성",
  "user.password": "비밀번호 변경",
  "member.invite": "팀원 초대",
  "member.invite_revoke": "초대 철회",
  "member.join": "초대 수락",
  "member.update": "팀원 변경",
  "member.deactivate": "팀원 비활성화",
  "site.create": "현장 생성",
  "site.update": "현장 변경",
  "asset.create": "설비 등록",
  "asset.update": "설비 변경",
  "asset.rotate_qr": "QR 재발급",
  "template.create": "서식 생성",
  "template.revise": "서식 개정",
  "kpi.definitions": "KPI 목표·가중치 변경",
  "kpi.snapshot": "KPI 기간 마감 저장",
  "inspection.submit": "점검 제출",
  "inspection.reviewed": "점검 검토",
  "inspection.rejected": "점검 반려",
  "inspection.correction_started": "정정본 작성",
  "report.approve": "보고서 승인",
  "report.reject": "보고서 반려",
  "finding.resolve": "지적 조치",
  "knowledge.create": "법령·규격 등록",
  "knowledge.update": "법령·규격 변경",
  "knowledge.verify": "법령·규격 확인",
};

// ---------------------------------------------------------------- small helpers

const roleLabel = (r) => store.me?.role_labels?.[r] || ROLE_FALLBACK[r] || r;
const roleList = (roles) => (Array.isArray(roles) ? roles : String(roles || "").split(",").filter(Boolean));
const rolesText = (roles) => roleList(roles).map(roleLabel).join(", ") || "—";
const roleOptions = () => ROLES.map((r) => ({ value: r, label: roleLabel(r) }));
const slotText = (slot) => (slot ? `${slot}열` : "열 없음");
const fmtNum = (n) => String(Math.round(Number(n) * 100) / 100);
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function errBox() {
  return h("p", { class: "field-error", role: "alert", hidden: true });
}

function showErr(el, message) {
  el.textContent = message || "";
  el.hidden = !message;
}

/** Label + group control (radio/checkbox sets must not sit inside a <label>). */
function group(label, control, hint) {
  return h("div", { class: "field" }, h("span", { class: "field-label" }, label), control,
    hint ? h("span", { class: "field-hint" }, hint) : null);
}

function spanAll(el) {
  el.classList.add("span-all");
  return el;
}

function textInput(attrs = {}) {
  return h("input", { class: "input", autocomplete: "off", ...attrs });
}

function numInput(value, { min, max }, step = 1) {
  return h("input", { class: "input", type: "number", inputmode: step === 1 ? "numeric" : "decimal", min, max, step,
    value: value ?? "" });
}

function readInt(input, { min, max, label, optional = true }) {
  const raw = input.value.trim();
  if (raw === "") {
    if (optional) return null;
    throw new Error(`${label}을(를) 입력하세요.`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}은(는) ${min}~${max} 사이의 정수로 입력하세요.`);
  return n;
}

function formHead(title) {
  return h("div", { class: "row" }, h("h3", { class: "row-main" }, title));
}

/** Button row that also carries row padding, so inline editors breathe inside list items. */
function actionRow(...buttons) {
  return h("div", { class: "btn-row row" }, buttons);
}

function onSubmit(form, button, errEl, handler) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (button.disabled) return;
    showErr(errEl, "");
    button.disabled = true;
    try {
      await handler();
    } catch (err) {
      showErr(errEl, describeError(err));
    } finally {
      button.disabled = false;
    }
  });
}

/** inlineConfirm, but the banner goes to the end of `container` (full width) instead of next to the button. */
function confirmBelow(container, anchor, opts) {
  container.querySelector(":scope > .banner-confirm")?.remove();
  const banner = inlineConfirm(anchor, opts);
  container.append(banner);
  banner.querySelector(".btn-row > .btn")?.focus();
  return banner;
}

/** "+ label" button that swaps itself for a create form; the form calls close() to swap back. */
function createToggle(label, build) {
  const wrap = h("div");
  const openBtn = h("button", { class: "btn", type: "button" }, icon("plus"), label);
  const bar = h("div", { class: "btn-row" }, openBtn);
  const close = () => {
    fill(wrap, bar);
    openBtn.focus();
  };
  openBtn.addEventListener("click", () => {
    fill(wrap, build(close));
    wrap.querySelector("input, textarea")?.focus();
  });
  wrap.append(bar);
  return wrap;
}

async function copyText(input) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(input.value);
    toast("링크를 복사했습니다.");
  } catch {
    // Plain-http origins have no async clipboard: select the text and try the legacy path.
    input.focus();
    input.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    toast(copied ? "링크를 복사했습니다." : "링크를 선택해 두었습니다. 길게 눌러 직접 복사하세요.");
  }
}

async function refreshReference() {
  try {
    await loadReference();
  } catch (err) {
    toast(`팀원·현장 목록을 새로 읽지 못했습니다: ${describeError(err)}`, { tone: "error" });
  }
}

// ---------------------------------------------------------------- folds

function makeFold(key, title) {
  const note = h("span", { class: "section-note" });
  const body = h("div", { class: "fold-body" });
  const el = h("details", { class: "fold", id: `settings-${key}` }, h("summary", null, h("span", null, title), note), body);
  const sec = {
    key, el, body, loaded: false, load: null, refresh: null,
    setNote(text) { note.textContent = text; },
    ensure() { if (!sec.loaded && sec.load) sec.load(); },
    reload() { return sec.loaded && sec.load ? sec.load({ quiet: true }) : undefined; },
  };
  el.addEventListener("toggle", () => {
    if (el.open) {
      sec.ensure();
      setQuery({ open: key });
    } else if (parseHash().query.open === key) {
      setQuery({ open: undefined });
    }
  });
  return sec;
}

/** First load shows a skeleton; later (quiet) reloads keep the current content until data arrives. */
function makeLoader(sec, fetcher, render) {
  let seq = 0;
  sec.load = async ({ quiet = false } = {}) => {
    const mine = ++seq;
    sec.loaded = true;
    if (!quiet) fill(sec.body, loadingState(3));
    let data;
    try {
      data = await fetcher();
    } catch (err) {
      if (err.name === "AbortError" || mine !== seq) return;
      if (quiet) {
        toast(describeError(err), { tone: "error" });
        return;
      }
      sec.loaded = false;
      fill(sec.body, errorState(err, () => sec.load()));
      return;
    }
    if (mine === seq) render(data);
  };
}

// ---------------------------------------------------------------- account

function appliedTheme() {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "auto";
}

function applyTheme(value) {
  const rootEl = document.documentElement;
  if (value === "light" || value === "dark") rootEl.dataset.theme = value;
  else delete rootEl.dataset.theme;
  try {
    localStorage.setItem(THEME_KEY, value);
  } catch {
    /* storage blocked: the theme still applies for this visit */
  }
  document.dispatchEvent(new CustomEvent("themechange"));
}

function accountSection(sec, ctx) {
  sec.loaded = true;
  const facts = h("dl", { class: "facts" });
  sec.refresh = () => {
    const u = store.user;
    sec.setNote(`${u.name} · ${rolesText(u.roles)}`);
    fill(facts,
      h("dt", null, "이름"), h("dd", null, personTag(u)),
      h("dt", null, "이메일"), h("dd", null, u.email || "—"),
      h("dt", null, "역할"), h("dd", null, rolesText(u.roles)),
      h("dt", null, "보드 열"), h("dd", null, u.board_slot ? `${u.board_slot}열` : "배치 안 됨"),
      h("dt", null, "팀"), h("dd", null, store.me?.org?.name || "—"));
  };
  sec.refresh();

  const themeSeg = seg({ label: "화면 테마", value: appliedTheme(), options: THEMES, onChange: applyTheme });
  // The rail/topbar toggle flips data-theme directly; keep this control in step with what is applied.
  const observer = new MutationObserver(() => {
    const now = appliedTheme();
    themeSeg.querySelectorAll("input").forEach((i) => { i.checked = i.value === now; });
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  ctx.onCleanup(() => observer.disconnect());

  const current = h("input", { class: "input", type: "password", autocomplete: "current-password", maxlength: 200 });
  const next = h("input", { class: "input", type: "password", autocomplete: "new-password", minlength: PASSWORD_MIN, maxlength: 200 });
  const again = h("input", { class: "input", type: "password", autocomplete: "new-password", maxlength: 200 });
  const pwErr = errBox();
  const pwSave = h("button", { class: "btn btn-primary", type: "submit" }, "비밀번호 변경");
  const pwForm = h("form", { class: "section", novalidate: true },
    h("h3", null, "비밀번호 변경"),
    h("div", { class: "form-grid" },
      field("현재 비밀번호", current),
      field("새 비밀번호", next, `${PASSWORD_MIN}자 이상`),
      field("새 비밀번호 확인", again)),
    pwErr, h("div", { class: "btn-row" }, pwSave));
  onSubmit(pwForm, pwSave, pwErr, async () => {
    if (!current.value) throw new Error("현재 비밀번호를 입력하세요.");
    if (next.value.length < PASSWORD_MIN) throw new Error(`새 비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`);
    if (next.value !== again.value) throw new Error("새 비밀번호 두 칸이 서로 다릅니다.");
    await api.post("api/auth/password", { current: current.value, new: next.value });
    pwForm.reset();
    toast("비밀번호를 바꿨습니다. 다음 로그인부터 새 비밀번호를 쓰세요.");
  });

  const logout = h("button", { class: "btn", type: "button" }, "로그아웃");
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    try {
      await api.post("api/auth/logout");
      try {
        // app.js boots offline from this cached identity; drop it so a logged-out device cannot.
        localStorage.removeItem(ME_CACHE_KEY);
      } catch {
        /* storage blocked: nothing cached */
      }
      location.reload();
    } catch (err) {
      logout.disabled = false;
      toast(describeError(err), { tone: "error" });
    }
  });

  fill(sec.body,
    facts,
    group("화면 테마", themeSeg, "자동은 기기의 밝게/어둡게 설정을 따릅니다."),
    pwForm,
    h("div", { class: "section" }, h("h3", null, "로그아웃"),
      h("p", { class: "field-hint" }, "이 기기에서 로그아웃합니다. 작성 중인 점검은 이 기기에 남아 있습니다."),
      h("div", { class: "btn-row" }, logout)),
  );
}

// ---------------------------------------------------------------- team

async function afterTeamChange(ctx, ids) {
  await refreshReference();
  if (ids.includes(store.user.id)) {
    try {
      store.me = { ...store.me, ...(await api.get("api/auth/me")) };
    } catch {
      /* keep the previous copy; the next boot refreshes it */
    }
    if (!store.has("admin")) {
      rerender();
      return;
    }
    ctx.sections.account?.refresh?.();
  }
  await ctx.sections.team?.reload();
}

function memberCard(m, active, freeSlots, ctx) {
  const isMe = m.id === store.user.id;
  let slot = m.board_slot || null;
  const roles = checkChips({ label: `${m.name} 역할`, options: roleOptions(), values: m.roles });
  const slotSeg = seg({ label: `${m.name} 보드 열`, value: slot ?? "", options: BOARD_SLOTS.map((s) => ({ value: s, label: `${s}열` })),
    onChange: (v) => { slot = Number(v); } });
  const clear = m.board_slot ? h("button", { class: "btn btn-sm", type: "button" }, "열에서 빼기") : null;
  const initials = textInput({ maxlength: 3, value: m.initials || "" });
  const err = errBox();
  const save = h("button", { class: "btn btn-primary", type: "submit", disabled: true }, "저장");
  const deactivate = isMe ? null : h("button", { class: "btn btn-danger", type: "button" }, "비활성화");
  const slotHint = m.board_slot ? null
    : freeSlots.length ? `열이 없는 팀원은 빈 열(${freeSlots.map((s) => `${s}열`).join(", ")})만 고를 수 있습니다.`
      : "빈 열이 없습니다. 다른 팀원을 열에서 빼면 배치할 수 있습니다.";
  const grid = h("div", { class: "form-grid" },
    spanAll(group("역할", roles)),
    spanAll(group("보드 열", h("div", { class: "btn-row" }, slotSeg, clear), slotHint)),
    field("이니셜", initials, "자석에 표시되는 1~3자"));
  const form = h("form", { class: "card card-flat section", novalidate: true },
    h("div", { class: "row" }, personTag(m),
      h("div", { class: "row-main" }, h("span", { class: "row-sub" }, m.email || "")),
      h("div", { class: "row-side" }, isMe ? badge("나", "accent") : null, badge(slotText(m.board_slot)))),
    grid, err, h("div", { class: "btn-row" }, save, deactivate));
  const markDirty = () => { save.disabled = false; };
  grid.addEventListener("input", markDirty);
  grid.addEventListener("change", markDirty);

  onSubmit(form, save, err, async () => {
    const chosenRoles = roles.values();
    if (!chosenRoles.length) throw new Error("역할을 하나 이상 고르세요.");
    const ini = initials.value.trim();
    if (!ini) throw new Error("이니셜을 입력하세요.");
    const body = { roles: chosenRoles, initials: ini };
    const slotChanged = slot && slot !== m.board_slot;
    if (slotChanged) body.board_slot = slot;
    const swapWith = slotChanged && m.board_slot ? active.find((o) => o.id !== m.id && o.board_slot === slot) : null;
    await api.patch(`api/team/${m.id}`, body);
    toast(swapWith ? `저장했습니다. ${swapWith.name} 님과 보드 열을 서로 바꿨습니다.` : "저장했습니다.");
    await afterTeamChange(ctx, [m.id, swapWith?.id]);
  });

  clear?.addEventListener("click", async () => {
    clear.disabled = true;
    showErr(err, "");
    try {
      await api.patch(`api/team/${m.id}`, { clear_slot: true });
      toast(`${m.name} 님을 보드 열에서 뺐습니다.`);
      await afterTeamChange(ctx, [m.id]);
    } catch (e) {
      showErr(err, describeError(e));
      clear.disabled = false;
    }
  });

  deactivate?.addEventListener("click", () => {
    const candidates = active.filter((o) => o.id !== m.id && o.board_slot).sort((a, b) => a.board_slot - b.board_slot);
    let reassignTo = null;
    const msg = errBox();
    const extra = h("div", { class: "field" },
      h("span", { class: "field-label" }, "업무·미조치 지적을 넘겨받을 팀원"),
      candidates.length
        ? chips({ label: "넘겨받을 팀원", options: candidates.map((o) => ({ value: o.id, node: personTag(o) })),
          onChange: (v) => { reassignTo = Number(v); } })
        : h("span", { class: "field-hint" }, "넘겨받을 수 있는 팀원(보드 열 배치)이 없습니다."),
      h("span", { class: "field-hint" }, "맡은 업무나 미조치 지적이 없으면 고르지 않아도 됩니다."),
      msg);
    confirmBelow(form, deactivate, {
      message: `${m.name} 님을 비활성화합니다. 로그인이 막히고 보드 열에서 빠집니다.`,
      confirmLabel: "비활성화",
      extra,
      onConfirm: async () => {
        try {
          await api.post(`api/team/${m.id}/deactivate`, { reassign_to: reassignTo });
        } catch (e) {
          if (e.code === "reassign_required") showErr(msg, e.message);
          throw e;
        }
        toast(`${m.name} 님을 비활성화했습니다.`);
        await afterTeamChange(ctx, [m.id]);
      },
    });
  });
  return form;
}

function inactiveRow(m) {
  return h("li", { class: "mute" }, h("div", { class: "row" },
    h("div", { class: "row-main" }, h("span", { class: "row-title" }, m.name),
      h("span", { class: "row-sub" }, [m.email, `${fmtDateTime(m.deactivated_at)} 비활성화`].filter(Boolean).join(" · "))),
    h("div", { class: "row-side" }, badge("비활성"))));
}

function inviteLinkBlock(res, name) {
  const link = `${location.origin}${location.pathname}#/invite/${res.token}`;
  const input = h("input", { class: "input", readonly: true, value: link });
  input.addEventListener("focus", () => input.select());
  const copy = h("button", { class: "btn btn-primary", type: "button" }, "링크 복사");
  copy.addEventListener("click", () => copyText(input));
  return h("div", { class: "section", role: "status" },
    field(`${name} 님 초대 링크`, input,
      `이 링크는 지금 한 번만 표시됩니다. 새 팀원에게 전달하세요. 7일 뒤(${fmtDateTime(res.expires_at)}) 만료됩니다.`),
    h("div", { class: "btn-row" }, copy));
}

function inviteForm(onInvited) {
  const email = textInput({ type: "email", inputmode: "email", maxlength: 120, placeholder: "name@example.com" });
  const name = textInput({ maxlength: 40 });
  const roles = checkChips({ label: "초대 역할", options: roleOptions(), values: ["worker"] });
  let slot = "";
  const slotWrap = h("div");
  const err = errBox();
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "초대 링크 만들기");
  const form = h("form", { class: "section", novalidate: true },
    h("div", { class: "form-grid" },
      field("이메일", email),
      field("이름", name),
      spanAll(group("역할", roles)),
      spanAll(group("보드 열", slotWrap, "나중에 팀원 설정에서 바꿀 수 있습니다."))),
    err, h("div", { class: "btn-row" }, submit));
  const el = h("div", { class: "card card-flat section" }, h("h3", null, "팀원 초대"), form);
  let result = null;

  function setSlots(active) {
    const options = [{ value: "", label: "없음" }, ...BOARD_SLOTS.map((s) => {
      const owner = active.find((m) => m.board_slot === s);
      return { value: s, label: owner ? `${s}열 · ${owner.name} 사용 중` : `${s}열`, disabled: Boolean(owner) };
    })];
    if (options.find((o) => String(o.value) === String(slot))?.disabled) slot = "";
    fill(slotWrap, chips({ label: "초대 보드 열", value: slot, options, onChange: (v) => { slot = v; } }));
  }

  onSubmit(form, submit, err, async () => {
    const body = { email: email.value.trim(), name: name.value.trim(), roles: roles.values(),
      board_slot: slot === "" ? null : Number(slot) };
    if (!body.email) throw new Error("이메일을 입력하세요.");
    if (!body.name) throw new Error("이름을 입력하세요.");
    if (!body.roles.length) throw new Error("역할을 하나 이상 고르세요.");
    const res = await api.post("api/auth/invite", body);
    const block = inviteLinkBlock(res, body.name);
    if (result) result.replaceWith(block);
    else el.append(block);
    result = block;
    email.value = "";
    name.value = "";
    toast("초대 링크를 만들었습니다.");
    await onInvited();
    block.querySelector("button")?.focus();
  });
  return { el, setSlots };
}

function pendingRow(inv, onChanged) {
  const revoke = h("button", { class: "btn btn-sm btn-danger", type: "button" }, "초대 철회");
  const li = h("li", null, h("div", { class: "row" },
    h("div", { class: "row-main" }, h("span", { class: "row-title" }, `${inv.name} · ${inv.email}`),
      h("span", { class: "row-sub" }, `${rolesText(inv.roles)} · ${slotText(inv.board_slot)} · ${fmtDateTime(inv.expires_at)}까지 유효`)),
    h("div", { class: "row-side" }, revoke)));
  revoke.addEventListener("click", () => confirmBelow(li, revoke, {
    message: `${inv.name} 님 초대를 철회합니다. 보낸 링크로는 더 이상 가입할 수 없습니다.`,
    confirmLabel: "철회",
    onConfirm: async () => {
      await api.del(`api/auth/invitations/${inv.id}`);
      toast("초대를 철회했습니다.");
      await onChanged();
    },
  }));
  return li;
}

function teamSection(sec, ctx) {
  sec.setNote(`활성 ${store.members.length}명`);
  const counts = { active: store.members.length, inactive: 0, pending: 0 };
  const updateNote = () => sec.setNote([`활성 ${counts.active}명`, counts.inactive ? `비활성 ${counts.inactive}명` : "",
    counts.pending ? `초대 대기 ${counts.pending}건` : ""].filter(Boolean).join(" · "));
  const membersWrap = h("div", { class: "section" });
  const pendingWrap = h("div", { class: "section" });
  let invite = null;

  function renderPending(items) {
    counts.pending = items.length;
    updateNote();
    fill(pendingWrap, h("h3", null, "대기 중인 초대"), items.length
      ? h("ul", { class: "list" }, items.map((inv) => pendingRow(inv, refreshPending)))
      : h("p", { class: "mute" }, "대기 중인 초대가 없습니다."));
  }

  async function refreshPending() {
    try {
      renderPending((await api.get("api/auth/invitations", {}, { signal: ctx.signal })).items);
    } catch (err) {
      if (err.name !== "AbortError") toast(describeError(err), { tone: "error" });
    }
  }

  makeLoader(sec, () => Promise.all([
    api.get("api/team", { include_inactive: true }, { signal: ctx.signal }),
    api.get("api/auth/invitations", {}, { signal: ctx.signal }),
  ]), ([team, invitations]) => {
    const active = team.items.filter((m) => m.active);
    const inactive = team.items.filter((m) => !m.active);
    counts.active = active.length;
    counts.inactive = inactive.length;
    const freeSlots = BOARD_SLOTS.filter((s) => !active.some((m) => m.board_slot === s));
    fill(membersWrap,
      h("p", { class: "field-hint" }, "보드 열(1~4열)에 배치된 팀원만 업무의 주 담당자가 될 수 있습니다. "
        + "다른 팀원이 쓰는 열을 고르면 두 사람의 열이 서로 바뀝니다."),
      h("div", { class: "grid-2" }, active.map((m) => memberCard(m, active, freeSlots, ctx))),
      inactive.length ? h("div", { class: "section" }, h("h3", null, `비활성 팀원 ${inactive.length}명`),
        h("ul", { class: "list" }, inactive.map(inactiveRow))) : null);
    renderPending(invitations.items);
    // The invite form survives reloads so a freshly shown link is not lost.
    if (!invite) invite = inviteForm(refreshPending);
    invite.setSlots(active);
    fill(sec.body, membersWrap, invite.el, pendingWrap);
  });
}

// ---------------------------------------------------------------- sites

async function afterSitesChange(ctx) {
  await refreshReference();
  await ctx.sections.sites?.reload();
  ctx.sections.assets?.reload();
}

function siteForm({ site = null, memberIds = [], card = false, onCancel, onSaved }) {
  const name = textInput({ maxlength: 80, value: site?.name ?? "" });
  const code = textInput({ maxlength: 30, value: site?.code ?? "" });
  const desc = h("textarea", { class: "textarea", maxlength: 1000 }, site?.description ?? "");
  const years = numInput(site?.retention_years ?? RETENTION_DEFAULT, RETENTION);
  let archived = Boolean(site?.archived);
  const memberOptions = store.members.map((m) => ({ value: m.id, label: m.name }));
  const members = checkChips({ label: "현장 팀원", options: memberOptions, values: memberIds });
  const err = errBox();
  const save = h("button", { class: "btn btn-primary", type: "submit" }, site ? "저장" : "현장 만들기");
  const cancel = h("button", { class: "btn", type: "button" }, "취소");
  cancel.addEventListener("click", onCancel);
  const form = h("form", { class: card ? "card card-flat section" : "section", novalidate: true },
    formHead(site ? `현장 편집 · ${site.name}` : "새 현장"),
    h("div", { class: "form-grid" },
      field("현장 식별명", name, "주소 대신 현장을 알아보는 이름"),
      field("코드 (선택)", code, "사내 관리 번호 등"),
      field("보관 기간(년)", years, "제출된 점검 기록·보고서 보관 기간(년)"),
      site ? group("상태", seg({ label: "현장 상태", value: archived ? "1" : "0",
        options: [{ value: "0", label: "운영 중" }, { value: "1", label: "보관" }], onChange: (v) => { archived = v === "1"; } }),
      "보관한 현장은 업무·설비의 현장 선택지에서 빠집니다.") : null,
      spanAll(field("설명 (선택)", desc)),
      spanAll(group("현장 팀원", members, memberOptions.length ? "이 현장을 맡는 팀원 (선택)" : "활성 팀원이 없습니다."))),
    err, actionRow(cancel, save));
  onSubmit(form, save, err, async () => {
    const siteName = name.value.trim();
    if (!siteName) throw new Error("현장 식별명을 입력하세요.");
    const body = {
      name: siteName,
      code: code.value.trim(),
      description: desc.value.trim(),
      retention_years: readInt(years, { ...RETENTION, label: "보관 기간", optional: false }),
      archived,
      member_ids: members.values().map(Number),
    };
    if (site) await api.patch(`api/sites/${site.id}`, body);
    else await api.post("api/sites", body);
    toast(site ? "현장을 저장했습니다." : "현장을 만들었습니다.");
    await onSaved();
  });
  return form;
}

function siteRow(s, ctx) {
  const li = h("li");
  function view() {
    const edit = h("button", { class: "btn btn-sm", type: "button" }, "편집");
    edit.addEventListener("click", openEditor);
    fill(li, h("div", { class: "row" },
      h("div", { class: "row-main" }, h("a", { class: "row-title", href: `#/sites/${s.id}` }, s.name),
        h("span", { class: "row-sub" }, [s.code, `진행 중 업무 ${s.open_tasks}`, `설비 ${s.asset_count}`,
          `미조치 지적 ${s.open_findings}`, `보관 ${s.retention_years}년`].filter(Boolean).join(" · "))),
      h("div", { class: "row-side" }, s.archived ? badge("보관됨") : null, edit)));
  }
  async function openEditor() {
    fill(li, loadingState(2));
    let detail;
    try {
      detail = await api.get(`api/sites/${s.id}`, {}, { signal: ctx.signal });
    } catch (err) {
      if (err.name === "AbortError") return;
      fill(li, errorState(err, openEditor), actionRow(h("button", { class: "btn", type: "button", onClick: view }, "닫기")));
      return;
    }
    fill(li, siteForm({ site: s, memberIds: detail.members.map((m) => m.id), onCancel: view,
      onSaved: () => afterSitesChange(ctx) }));
    li.querySelector("input")?.focus();
  }
  view();
  return li;
}

function sitesSection(sec, ctx) {
  sec.setNote(`현장 ${store.sites.length}곳`);
  const create = createToggle("현장 추가", (close) => siteForm({ card: true, onCancel: close,
    onSaved: async () => { close(); await afterSitesChange(ctx); } }));
  makeLoader(sec, () => api.get("api/sites", { include_archived: true }, { signal: ctx.signal }), ({ items }) => {
    const archived = items.filter((s) => s.archived).length;
    sec.setNote(`현장 ${items.length - archived}곳${archived ? ` · 보관 ${archived}곳` : ""}`);
    fill(sec.body, create, items.length
      ? h("ul", { class: "list" }, items.map((s) => siteRow(s, ctx)))
      : emptyState({ title: "현장이 없습니다", text: "업무와 설비는 현장 단위로 묶입니다. ‘현장 추가’로 첫 현장을 만드세요." }));
  });
}

// ---------------------------------------------------------------- assets + QR

const templateText = (a) => (a.template_name ? `${a.template_name} v${a.template_version}` : "없음");

function openQrLabel(a, ctx) {
  const base = `${location.origin}${location.pathname}`;
  const img = h("img", { src: `api/assets/${a.id}/qr.svg?base=${encodeURIComponent(base)}`, alt: `${a.name} QR 코드`,
    width: 220, height: 220 });
  const close = h("button", { class: "btn", type: "button" }, "닫기");
  const print = h("button", { class: "btn btn-primary", type: "button" }, "인쇄");
  img.addEventListener("error", () => {
    img.replaceWith(h("p", { class: "field-error", role: "alert" }, "QR 이미지를 불러오지 못했습니다. 창을 닫고 다시 열어 보세요."));
    print.disabled = true;
  });
  const sheet = openSheet({
    title: "QR 라벨",
    body: [
      h("div", { class: "label-print" }, img, h("strong", null, a.name),
        h("span", null, [a.site_name, a.location].filter(Boolean).join(" · ")), h("span", { class: "hash" }, a.public_token)),
      h("p", { class: "field-hint no-print" }, "휴대폰 카메라로 찍으면 앱에서 이 설비가 열립니다 (로그인 필요)."),
    ],
    actions: [close, print],
    onClose: () => {
      document.body.classList.remove("printing-label");
      ctx.sheets.delete(sheet);
    },
  });
  ctx.sheets.add(sheet);
  close.addEventListener("click", () => sheet.close());
  print.addEventListener("click", () => {
    document.body.classList.add("printing-label");
    window.addEventListener("afterprint", () => document.body.classList.remove("printing-label"), { once: true });
    window.print();
  });
}

function assetForm({ asset = null, templates = [], defaultSite = "", card = false, onCancel, onSaved }) {
  const siteOptions = store.sites.map((s) => ({ value: s.id, label: s.name }));
  if (asset && !siteOptions.some((o) => o.value === asset.site_id)) {
    siteOptions.push({ value: asset.site_id, label: `${asset.site_name} (보관됨)` });
  }
  let siteId = asset?.site_id ?? ((Number(defaultSite) || siteOptions[0]?.value) ?? null);
  const tplOptions = [{ value: "", label: "서식 없음" }, ...templates.map((t) => ({ value: t.id, label: `${t.name} v${t.version}` }))];
  if (asset?.template_id && !templates.some((t) => t.id === asset.template_id)) {
    tplOptions.push({ value: asset.template_id, label: `${templateText(asset)} (이전 버전)` });
  }
  let templateId = asset?.template_id ?? "";
  const name = textInput({ maxlength: 80, value: asset?.name ?? "" });
  const type = textInput({ maxlength: 40, value: asset?.asset_type ?? "", placeholder: "예: 분전반" });
  const loc = textInput({ maxlength: 120, value: asset?.location ?? "", placeholder: "예: 지하 1층 전기실" });
  const installed = h("input", { class: "input", type: "date", value: asset?.installed_on ?? "" });
  const life = numInput(asset?.service_life_years, SERVICE_LIFE);
  const interval = numInput(asset?.inspection_interval_days, INTERVAL_DAYS);
  const err = errBox();
  const save = h("button", { class: "btn btn-primary", type: "submit" }, asset ? "저장" : "설비 등록");
  const cancel = h("button", { class: "btn", type: "button" }, "취소");
  cancel.addEventListener("click", onCancel);
  const form = h("form", { class: card ? "card card-flat section" : "section", novalidate: true },
    formHead(asset ? `설비 편집 · ${asset.name}` : "새 설비"),
    h("div", { class: "form-grid" },
      spanAll(group("현장", chips({ label: "설비 현장", value: siteId, options: siteOptions, onChange: (v) => { siteId = Number(v); } }))),
      field("설비 이름", name),
      field("설비 유형", type),
      field("설치 위치 (선택)", loc),
      spanAll(group("점검 서식", chips({ label: "점검 서식", value: templateId, options: tplOptions, onChange: (v) => { templateId = v; } }),
        "이 설비를 점검할 때 쓰는 항목 목록")),
      field("설치일 (선택)", installed),
      field("내용연수(년, 선택)", life, "설치일과 함께 넣으면 만료가 가까울 때 표시합니다"),
      field("점검 주기(일, 선택)", interval, "최근 점검일 + 주기로 다음 점검일을 계산합니다")),
    err, actionRow(cancel, save));
  onSubmit(form, save, err, async () => {
    if (!siteId) throw new Error("현장을 고르세요.");
    const body = {
      site_id: Number(siteId),
      name: name.value.trim(),
      asset_type: type.value.trim(),
      location: loc.value.trim(),
      template_id: templateId === "" ? null : Number(templateId),
      installed_on: installed.value || null,
      service_life_years: readInt(life, { ...SERVICE_LIFE, label: "내용연수" }),
      inspection_interval_days: readInt(interval, { ...INTERVAL_DAYS, label: "점검 주기" }),
      archived: Boolean(asset?.archived),
    };
    if (!body.name) throw new Error("설비 이름을 입력하세요.");
    if (!body.asset_type) throw new Error("설비 유형을 입력하세요.");
    if (asset) await api.patch(`api/assets/${asset.id}`, body);
    else await api.post("api/assets", body);
    toast(asset ? "설비를 저장했습니다." : "설비를 등록했습니다. QR 라벨을 인쇄해 붙이세요.");
    await onSaved();
  });
  return form;
}

function assetRow(a, ctx, getTemplates, onChanged) {
  const li = h("li");
  function view() {
    const qr = h("button", { class: "btn btn-sm", type: "button" }, icon("qr", "icon icon-sm"), "QR 라벨");
    const edit = h("button", { class: "btn btn-sm", type: "button" }, "편집");
    const rotate = h("button", { class: "btn btn-sm btn-danger", type: "button" }, "QR 재발급");
    qr.addEventListener("click", () => openQrLabel(a, ctx));
    edit.addEventListener("click", () => {
      fill(li, assetForm({ asset: a, templates: getTemplates(), onCancel: view, onSaved: onChanged }));
      li.querySelector("input")?.focus();
    });
    rotate.addEventListener("click", () => confirmBelow(li, rotate, {
      message: "재발급하면 이미 붙인 QR 라벨은 더 이상 열리지 않습니다. 새 라벨을 인쇄해 바꿔 붙여야 합니다.",
      confirmLabel: "재발급",
      onConfirm: async () => {
        Object.assign(a, await api.post(`api/assets/${a.id}/rotate-token`));
        toast("QR을 새로 만들었습니다. 새 라벨을 인쇄하세요.");
        view();
        openQrLabel(a, ctx);
      },
    }));
    const lifeTone = LIFE_TONE[a.life?.state];
    fill(li,
      h("div", { class: "row" },
        h("div", { class: "row-main" },
          h("span", { class: "row-title" }, a.name),
          h("span", { class: "row-sub" }, [a.asset_type, a.site_name, a.location || "위치 미입력"].join(" · ")),
          h("span", { class: "row-sub" }, [`서식 ${templateText(a)}`,
            `최근 점검 ${a.last_inspected_at ? fmtDateTime(a.last_inspected_at) : "없음"}`,
            lifeTone ? null : a.life?.label].filter(Boolean).join(" · "))),
        lifeTone ? h("div", { class: "row-side" }, badge(a.life.label, lifeTone, "alert")) : null),
      actionRow(qr, edit, rotate));
  }
  view();
  return li;
}

function assetsSection(sec, ctx) {
  sec.setNote("설비 목록·QR 라벨");
  let siteFilter = ctx.query.asset_site || "";
  let templates = [];
  let seq = 0;
  const filterWrap = h("div");
  const listWrap = h("div", { class: "section" });
  const afterChange = async () => {
    ctx.sections.sites?.reload();
    await loadList();
  };
  const create = createToggle("설비 추가", (close) => assetForm({ card: true, templates, defaultSite: siteFilter, onCancel: close,
    onSaved: async () => { close(); await afterChange(); } }));

  function renderFilter() {
    if (siteFilter && !store.site(siteFilter)) siteFilter = "";
    fill(filterWrap, group("현장", chips({ label: "현장 필터", value: siteFilter,
      options: [{ value: "", label: "전체" }, ...store.sites.map((s) => ({ value: s.id, label: s.name }))],
      onChange: (v) => { siteFilter = v; setQuery({ asset_site: v || undefined }); loadList(); } })));
  }

  function renderList(items) {
    const siteName = siteFilter ? store.site(siteFilter)?.name || "" : "";
    sec.setNote(siteName ? `${siteName} 설비 ${items.length}대` : `설비 ${items.length}대`);
    fill(listWrap, items.length
      ? h("ul", { class: "list" }, items.map((a) => assetRow(a, ctx, () => templates, afterChange)))
      : emptyState({ title: siteName ? `${siteName}에 등록된 설비가 없습니다` : "등록된 설비가 없습니다",
        text: "‘설비 추가’로 분전반·수배전반 같은 설비를 등록하면 QR 라벨을 인쇄할 수 있습니다." }));
  }

  async function loadList() {
    const mine = ++seq;
    fill(listWrap, loadingState(3));
    try {
      const res = await api.get("api/assets", { site_id: siteFilter || undefined }, { signal: ctx.signal });
      if (mine === seq) renderList(res.items);
    } catch (err) {
      if (err.name !== "AbortError" && mine === seq) fill(listWrap, errorState(err, loadList));
    }
  }

  makeLoader(sec, () => api.get("api/templates", {}, { signal: ctx.signal }), (res) => {
    templates = res.items;
    if (!store.sites.length) {
      sec.setNote("현장 없음");
      fill(sec.body, emptyState({ title: "현장이 없습니다", text: "설비는 현장에 속합니다. 현장을 먼저 만드세요.",
        action: ctx.sections.sites ? h("button", { class: "btn btn-sm", type: "button", onClick: () => ctx.openSection("sites") },
          "현장 설정 열기") : null }));
      return;
    }
    renderFilter();
    fill(sec.body, filterWrap, create, listWrap);
    loadList();
  });
}

// ---------------------------------------------------------------- templates

function parseTemplateItems(text) {
  const items = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const bar = line.indexOf("|");
    const section = bar >= 0 ? line.slice(0, bar).trim() : "";
    const label = bar >= 0 ? line.slice(bar + 1).trim() : line;
    const at = `${i + 1}번째 줄`;
    if (!label) throw new Error(`${at}: 항목 내용이 비어 있습니다.`);
    if (section.length > TEMPLATE_LIMITS.section) throw new Error(`${at}: 구분은 ${TEMPLATE_LIMITS.section}자까지입니다.`);
    if (label.length > TEMPLATE_LIMITS.label) throw new Error(`${at}: 항목은 ${TEMPLATE_LIMITS.label}자까지입니다.`);
    items.push({ section, label });
  });
  if (!items.length) throw new Error("점검 항목을 한 줄 이상 입력하세요.");
  if (items.length > TEMPLATE_LIMITS.items) throw new Error(`항목은 ${TEMPLATE_LIMITS.items}개까지입니다 (지금 ${items.length}개).`);
  return items;
}

const formatTemplateItems = (items) => items.map((i) => (i.section ? `${i.section} | ${i.label}` : i.label)).join("\n");

function templateForm({ template = null, card = false, onCancel, onSaved }) {
  const name = textInput({ maxlength: 80, value: template?.name ?? "" });
  const type = template ? null : textInput({ maxlength: 40, placeholder: "예: 분전반" });
  const itemsText = h("textarea", { class: "textarea", rows: 10, placeholder: "외관 | 외함 손상·부식·변형\n차단기 | 누전차단기 시험 버튼 동작" },
    template ? formatTemplateItems(template.items) : "");
  const count = h("span", { class: "field-hint num", "aria-live": "polite" });
  const updateCount = () => {
    const n = itemsText.value.split("\n").filter((l) => l.trim()).length;
    count.textContent = `항목 ${n}개`;
  };
  itemsText.addEventListener("input", updateCount);
  updateCount();
  const err = errBox();
  const save = h("button", { class: "btn btn-primary", type: "submit" }, template ? `v${template.version + 1}로 개정` : "서식 만들기");
  const cancel = h("button", { class: "btn", type: "button" }, "취소");
  cancel.addEventListener("click", onCancel);
  const form = h("form", { class: card ? "card card-flat section" : "section", novalidate: true },
    formHead(template ? `서식 개정 · ${template.name} v${template.version}` : "새 점검 서식"),
    template ? h("p", { class: "callout" }, icon("info"), h("span", null,
      `저장하면 새 버전(v${template.version + 1})이 만들어지고, 이 서식을 쓰는 설비가 새 버전으로 옮겨집니다. `
      + "이미 제출된 점검은 원래 버전 그대로 남습니다.")) : null,
    h("div", { class: "form-grid" },
      field("서식 이름", name),
      template ? group("설비 유형", h("span", null, template.asset_type || "—"), "개정해도 설비 유형은 그대로입니다.")
        : field("설비 유형", type),
      spanAll(h("label", { class: "field" }, h("span", null, "점검 항목"), itemsText,
        h("span", { class: "field-hint" }, "한 줄에 한 항목. ‘구분 | 항목’ 형식이며 구분은 생략할 수 있습니다."), count))),
    err, actionRow(cancel, save));
  onSubmit(form, save, err, async () => {
    const body = { name: name.value.trim(), asset_type: template ? template.asset_type : type.value.trim(),
      items: parseTemplateItems(itemsText.value) };
    if (!body.name) throw new Error("서식 이름을 입력하세요.");
    if (!body.asset_type) throw new Error("설비 유형을 입력하세요.");
    if (template) await api.post(`api/templates/${template.id}/revise`, body);
    else await api.post("api/templates", body);
    toast(template ? `v${template.version + 1}로 개정했습니다.` : "서식을 만들었습니다.");
    await onSaved();
  });
  return form;
}

function templateRow(t, onChanged) {
  const li = h("li");
  function view() {
    const revise = h("button", { class: "btn btn-sm", type: "button" }, "개정");
    revise.addEventListener("click", () => {
      fill(li, templateForm({ template: t, onCancel: view, onSaved: onChanged }));
      li.querySelector("input")?.focus();
    });
    fill(li,
      h("div", { class: "row" },
        h("div", { class: "row-main" }, h("span", { class: "row-title" }, t.name),
          h("span", { class: "row-sub" }, [t.asset_type || "유형 없음", `항목 ${t.items.length}개`, `${fmtDateTime(t.created_at)} 작성`].join(" · "))),
        h("div", { class: "row-side" }, badge(`v${t.version}`), t.is_sample ? badge("예시 서식", "warn") : null)),
      t.is_sample ? h("p", { class: "field-hint" }, "실제 법정 서식·설비 유형으로 교체하세요.") : null,
      h("details", { class: "inline" }, h("summary", null, `항목 ${t.items.length}개 보기`),
        h("dl", { class: "def-list" }, t.items.map((i) => [h("dt", null, i.section || "—"), h("dd", null, i.label)]))),
      actionRow(revise));
  }
  view();
  return li;
}

function templatesSection(sec, ctx) {
  sec.setNote("설비별 점검 항목");
  const afterChange = async () => {
    await sec.reload();
    ctx.sections.assets?.reload();
  };
  const create = createToggle("서식 추가", (close) => templateForm({ card: true, onCancel: close,
    onSaved: async () => { close(); await afterChange(); } }));
  makeLoader(sec, () => api.get("api/templates", {}, { signal: ctx.signal }), ({ items }) => {
    const samples = items.filter((t) => t.is_sample).length;
    sec.setNote(`서식 ${items.length}개${samples ? ` · 예시 ${samples}개` : ""}`);
    fill(sec.body, create, items.length
      ? h("ul", { class: "list" }, items.map((t) => templateRow(t, afterChange)))
      : emptyState({ title: "점검 서식이 없습니다", text: "‘서식 추가’로 설비 유형별 점검 항목을 만드세요." }));
  });
}

// ---------------------------------------------------------------- KPI

function kpiChangeLines(entry, names) {
  let detail;
  try {
    detail = JSON.parse(entry.detail_json || "{}");
  } catch {
    return ["변경 내용을 읽을 수 없습니다."];
  }
  const pair = (label, v) => (Array.isArray(v) && Number(v[0]) !== Number(v[1]) ? `${label} ${fmtNum(v[0])} → ${fmtNum(v[1])}` : null);
  return Object.entries(detail).map(([key, ch]) => {
    const parts = [pair("목표", ch?.target), pair("가중치", ch?.weight)].filter(Boolean);
    return `${names[key] || key}: ${parts.join(", ") || "변경 없음"}`;
  });
}

function kpiSection(sec, ctx) {
  sec.setNote("목표·가중치");
  makeLoader(sec, () => Promise.all([
    api.get("api/kpi/definitions", {}, { signal: ctx.signal }),
    api.get("api/kpi/snapshots", {}, { signal: ctx.signal }),
  ]), ([defs, snaps]) => {
    const total = defs.weight_total;
    const names = Object.fromEntries(defs.items.map((d) => [d.key, d.name]));
    const rows = defs.items.map((d) => {
      const target = numInput(fmtNum(d.target), { min: 0, max: 100 }, "any");
      const weight = numInput(fmtNum(d.weight), { min: 0, max: total }, "any");
      return { d, target, weight, el: h("div", { class: "card card-flat section" }, h("h3", null, d.name),
        h("p", { class: "field-hint" }, d.description),
        h("div", { class: "form-grid" }, field("목표(%)", target, "0 초과 100 이하"), field("가중치", weight))) };
    });
    const sumEl = h("p", { class: "num" });
    const err = errBox();
    const save = h("button", { class: "btn btn-primary", type: "submit" }, "저장");

    const validate = () => {
      let msg = "";
      for (const r of rows) {
        const t = r.target.value === "" ? NaN : Number(r.target.value);
        const w = r.weight.value === "" ? NaN : Number(r.weight.value);
        if (!Number.isFinite(t) || t <= 0 || t > 100) { msg = `${r.d.name}: 목표는 0 초과 100 이하로 입력하세요.`; break; }
        if (!Number.isFinite(w) || w < 0) { msg = `${r.d.name}: 가중치는 0 이상으로 입력하세요.`; break; }
      }
      const sum = rows.reduce((s, r) => s + (Number(r.weight.value) || 0), 0);
      if (!msg && Math.abs(sum - total) > WEIGHT_EPS) msg = `가중치 합계가 ${fmtNum(total)}이어야 합니다 (지금 ${fmtNum(sum)}).`;
      return { sum, msg };
    };
    const check = () => {
      const { sum, msg } = validate();
      sumEl.textContent = `가중치 합계 ${fmtNum(sum)} / ${fmtNum(total)}`;
      showErr(err, msg);
      save.disabled = Boolean(msg);
      return sum;
    };

    const form = h("form", { class: "section", novalidate: true },
      rows.length ? h("div", { class: "grid-2" }, rows.map((r) => r.el))
        : emptyState({ title: "KPI 지표가 없습니다", text: "서버 초기 설정에서 기본 지표가 만들어지지 않았습니다. 서버 관리자에게 알리세요." }),
      sumEl, err, h("div", { class: "btn-row" }, save));
    form.addEventListener("input", check);
    onSubmit(form, save, err, async () => {
      const { msg } = validate();
      if (msg) throw new Error(msg);
      await api.put("api/kpi/definitions", { items: rows.map((r) => ({ key: r.d.key, target: Number(r.target.value),
        weight: Number(r.weight.value) })) });
      toast("KPI 목표·가중치를 저장했습니다. KPI 화면의 달성률이 새 값으로 계산됩니다.");
      await sec.reload();
    });
    const sum = check();
    sec.setNote(`지표 ${rows.length}개 · 가중치 합 ${fmtNum(sum)}`);

    const history = defs.history.length
      ? h("ul", { class: "list" }, defs.history.map((entry) => h("li", null, h("div", { class: "row" },
        h("div", { class: "row-main" }, h("span", { class: "row-title" }, `${entry.actor_name || "알 수 없음"} · ${fmtDateTime(entry.created_at)}`),
          kpiChangeLines(entry, names).map((line) => h("span", { class: "row-sub" }, line)))))))
      : h("p", { class: "mute" }, "아직 바꾼 적이 없습니다. 기본 목표·가중치를 쓰는 중입니다.");

    const snapshots = snaps.items.length
      ? h("ul", { class: "list" }, snaps.items.map((s) => h("li", null, h("div", { class: "row" },
        h("div", { class: "row-main" },
          h("span", { class: "row-title" }, `${s.period_start} ~ ${s.period_end} · ${s.scope === "team" ? "팀" : store.member(s.user_id)?.name || "개인"}`),
          h("span", { class: "row-sub" }, `${s.created_by_name} 저장 · ${fmtDateTime(s.created_at)}`)),
        h("div", { class: "row-side num" }, `가중평균 ${s.weighted === null || s.weighted === undefined ? "—" : `${Number(s.weighted).toFixed(1)}%`}`)))))
      : emptyState({ title: "저장된 기간 마감 기록이 없습니다", text: "KPI 화면에서 ‘기간 마감 저장’을 누르면 그 시점의 값이 여기에 남습니다.",
        action: h("a", { class: "btn btn-sm", href: "#/kpi" }, "KPI 화면으로") });

    fill(sec.body,
      h("p", { class: "field-hint" }, "가중평균 달성률 = Σ(지표 달성률 × 가중치) ÷ Σ(가중치). 가중치 합계는 "
        + `${fmtNum(total)}이어야 저장됩니다.`),
      form,
      h("section", { class: "section" }, h("h3", null, "변경 이력"), history),
      h("section", { class: "section" }, h("h3", null, "기간 마감 기록"), snapshots));
  });
}

// ---------------------------------------------------------------- audit

function auditRow(e) {
  const detail = e.detail_json && e.detail_json !== "{}" ? e.detail_json : "";
  const known = AUDIT_ACTIONS[e.action];
  const hasId = e.entity_id !== null && e.entity_id !== undefined;
  return h("tr", null,
    h("td", { class: "num" }, fmtDateTime(e.created_at)),
    h("td", null, e.actor_name || "시스템"),
    h("td", null, known || e.action, known ? h("div", { class: "hash" }, e.action) : null),
    h("td", null, `${e.entity_type}${hasId ? ` #${e.entity_id}` : ""}`),
    h("td", { class: "hash", title: detail || null }, detail ? truncate(detail, DETAIL_MAX) : "—"));
}

function verifyBlock(ctx) {
  const run = h("button", { class: "btn", type: "button" }, "해시 체인 검증");
  const out = h("p", { role: "status", hidden: true });
  run.addEventListener("click", async () => {
    run.disabled = true;
    out.hidden = false;
    fill(out, "검증 중…");
    try {
      const r = await api.get("api/audit/verify", {}, { signal: ctx.signal });
      fill(out, r.ok ? badge("체인 정상", "ok", "check") : badge("체인 끊김", "danger", "alert"), " ",
        r.ok ? `기록 ${r.checked}건을 처음부터 확인했습니다 (${fmtDateTime(new Date().toISOString())} 기준).`
          : `#${r.broken_at} 기록에서 체인이 끊겼습니다 (전체 ${r.checked}건). 기록이 고쳐졌을 수 있으니 서버 관리자에게 알리세요.`);
    } catch (err) {
      if (err.name !== "AbortError") fill(out, h("span", { class: "field-error" }, describeError(err)));
    } finally {
      run.disabled = false;
    }
  });
  return h("div", { class: "section" }, h("div", { class: "btn-row" }, run), out);
}

function auditSection(sec, ctx) {
  sec.setNote(`최근 ${AUDIT_LIMIT}건`);
  const verify = store.has("admin") ? verifyBlock(ctx) : null;
  makeLoader(sec, () => api.get("api/audit", { limit: AUDIT_LIMIT }, { signal: ctx.signal }), ({ items }) => {
    sec.setNote(`최근 ${items.length}건`);
    fill(sec.body,
      h("p", { class: "field-hint" }, "기록마다 앞 기록의 해시를 이어 받아, 중간 기록이 고쳐지면 체인이 끊깁니다."),
      verify,
      items.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
          h("thead", null, h("tr", null, ["시각", "사용자", "작업", "대상", "내용"].map((t) => h("th", { scope: "col" }, t)))),
          h("tbody", null, items.map(auditRow))))
        : emptyState({ title: "감사 기록이 없습니다", text: "팀원·현장·점검에 변경이 생기면 여기에 쌓입니다." }));
  });
}

// ---------------------------------------------------------------- about

function aboutSection(sec) {
  sec.loaded = true;
  sec.setNote("저장 위치 · API 문서");
  fill(sec.body, h("dl", { class: "facts" },
    h("dt", null, "서버"), h("dd", null, "업무·점검 기록·KPI 설정은 서버 DB에, 사진·서명 같은 증빙 파일은 서버 저장소에 보관됩니다."),
    h("dt", null, "이 기기"), h("dd", null, "작성 중인 점검은 이 기기(IndexedDB)에 임시 저장되고, 서버가 제출을 확인한 뒤 지워집니다. "
      + "보내기 전에 브라우저 데이터를 지우면 작성분이 사라질 수 있습니다."),
    h("dt", null, "API 문서"), h("dd", null, h("a", { href: "api/docs", target: "_blank", rel: "noopener" }, "api/docs 열기 ",
      icon("external", "icon icon-sm")))));
}

// ---------------------------------------------------------------- page

export async function renderSettings(root, { query, signal, onCleanup }) {
  const isAdmin = store.has("admin");
  const ctx = { query, signal, onCleanup, sections: {}, sheets: new Set(), openSection: null };
  const specs = [
    ["account", "내 계정", accountSection],
    isAdmin && ["team", "팀원", teamSection],
    isAdmin && ["sites", "현장", sitesSection],
    isAdmin && ["assets", "설비·QR", assetsSection],
    isAdmin && ["templates", "점검 서식", templatesSection],
    isAdmin && ["kpi", "KPI 목표·가중치", kpiSection],
    store.has("admin", "reviewer") && ["audit", "감사 로그", auditSection],
    ["about", "앱 정보", aboutSection],
  ].filter(Boolean);
  const folds = specs.map(([key, title, build]) => {
    const sec = makeFold(key, title);
    ctx.sections[key] = sec;
    build(sec, ctx);
    return sec.el;
  });
  ctx.openSection = (key) => {
    const sec = ctx.sections[key];
    if (!sec) return;
    sec.el.open = true;
    sec.ensure();
    requestAnimationFrame(() => sec.el.scrollIntoView({ block: "start" }));
  };
  onCleanup(() => {
    ctx.sheets.forEach((s) => s.close());
    document.body.classList.remove("printing-label");
  });

  const sub = isAdmin ? "내 계정과 팀원·현장·설비·점검 서식·KPI를 관리합니다." : "내 계정과 화면 설정, 앱 정보";
  root.append(h("section", { class: "page page-narrow" },
    h("header", { class: "page-head" }, h("div", null, h("h1", null, "설정"),
      h("p", { class: "page-sub" }, [store.me?.org?.name, sub].filter(Boolean).join(" · ")))),
    h("div", { class: "section" }, folds)));

  if (query.open && ctx.sections[query.open]) ctx.openSection(query.open);
}
