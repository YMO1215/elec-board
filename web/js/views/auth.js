// Setup (first run), login and invitation acceptance.
import { api } from "../api.js";
import { fill, h, icon } from "../dom.js";
import { describeError, errorState, field, loadingState } from "../ui.js";

function brand() {
  return h("div", { class: "brand" }, icon("bolt"), h("span", null, "전기 업무 보드"));
}

function formError() {
  return h("p", { class: "field-error", role: "alert", hidden: true });
}

function showError(el, err) {
  el.textContent = describeError(err);
  el.hidden = false;
}

export function renderSetup(root, onDone) {
  const err = formError();
  const token = h("input", { class: "input", name: "setup_token", autocomplete: "off" });
  const tokenField = field("초기 설정 토큰", token, "서버에 ELEC_SETUP_TOKEN 이 설정된 경우에만 필요합니다.");
  tokenField.hidden = true;
  const form = h("form", { class: "card form-grid" },
    h("div", { class: "span-all" }, h("h1", null, "처음 설정"), h("p", { class: "page-sub" }, "팀과 첫 관리자 계정을 만듭니다. 나머지 팀원은 설정 화면에서 초대합니다.")),
    field("팀 이름", h("input", { class: "input", name: "org_name", required: true, maxlength: 80 })),
    field("관리자 이름", h("input", { class: "input", name: "name", required: true, maxlength: 40, autocomplete: "name" })),
    field("이메일", h("input", { class: "input", name: "email", type: "email", required: true, autocomplete: "username" })),
    field("비밀번호", h("input", { class: "input", name: "password", type: "password", required: true, minlength: 8,
      autocomplete: "new-password" }), "8자 이상"),
    tokenField,
    h("div", { class: "span-all" }, err),
    h("div", { class: "span-all" }, h("button", { class: "btn btn-primary", type: "submit" }, "팀 만들기")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.setup_token) delete data.setup_token;
    try {
      const res = await api.post("api/auth/setup", data);
      onDone(res.me);
    } catch (e2) {
      if (e2.status === 403) tokenField.hidden = false;
      showError(err, e2);
    }
  });
  fill(root, h("div", { class: "auth-wrap" }, brand(), form));
}

export function renderLogin(root, onDone) {
  const err = formError();
  const form = h("form", { class: "card form-grid" },
    h("div", { class: "span-all" }, h("h1", null, "로그인")),
    h("div", { class: "span-all" }, field("이메일", h("input", { class: "input", name: "email", type: "email", required: true,
      autocomplete: "username" }))),
    h("div", { class: "span-all" }, field("비밀번호", h("input", { class: "input", name: "password", type: "password",
      required: true, autocomplete: "current-password" }))),
    h("div", { class: "span-all" }, err),
    h("div", { class: "span-all" }, h("button", { class: "btn btn-primary btn-block", type: "submit" }, "로그인")),
    h("p", { class: "span-all field-hint" }, "계정이 없다면 관리자에게 초대 링크를 요청하세요."));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await api.post("api/auth/login", Object.fromEntries(new FormData(form)), { quiet401: true });
      onDone(res.me);
    } catch (e2) {
      showError(err, e2);
    }
  });
  fill(root, h("div", { class: "auth-wrap" }, brand(), form));
  form.querySelector("input").focus();
}

export async function renderInvite(root, token, onDone) {
  fill(root, h("div", { class: "auth-wrap" }, brand(), loadingState(2)));
  let preview;
  try {
    preview = await api.get(`api/auth/invite/${encodeURIComponent(token)}`);
  } catch (e) {
    fill(root, h("div", { class: "auth-wrap" }, brand(), errorState(
      e.status === 404 ? { message: "초대 링크가 만료되었거나 이미 사용되었습니다. 관리자에게 새 링크를 요청하세요." } : e)));
    return;
  }
  const err = formError();
  const form = h("form", { class: "card form-grid" },
    h("div", { class: "span-all" }, h("h1", null, `${preview.org_name}에 참여`),
      h("p", { class: "page-sub" }, `${preview.name} · ${preview.email}`)),
    h("div", { class: "span-all" }, field("비밀번호 정하기", h("input", { class: "input", name: "password", type: "password",
      required: true, minlength: 8, autocomplete: "new-password" }), "8자 이상")),
    h("div", { class: "span-all" }, err),
    h("div", { class: "span-all" }, h("button", { class: "btn btn-primary btn-block", type: "submit" }, "참여하기")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`api/auth/invite/${encodeURIComponent(token)}/accept`, Object.fromEntries(new FormData(form)));
      onDone(res.me);
    } catch (e2) {
      showError(err, e2);
    }
  });
  fill(root, h("div", { class: "auth-wrap" }, brand(), form));
}
