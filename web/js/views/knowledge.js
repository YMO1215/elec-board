// 법령·규격: title, short summary, source, check date and a link to the official
// text. Full legal texts are never stored; the official source is always primary.
import { api } from "../api.js";
import { append, debounce, fill, h, icon } from "../dom.js";
import { setQuery } from "../router.js";
import { on, store } from "../store.js";
import {
  badge, chips, describeError, emptyState, errorState, field, inlineConfirm, loadingState, openSheet, seg, toast,
} from "../ui.js";

const CATEGORIES = [
  { value: "law", label: "법령" },
  { value: "kec", label: "KEC" },
  { value: "ks", label: "KS" },
  { value: "inspection", label: "검사" },
  { value: "education", label: "교육" },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));
const SEARCH_DELAY_MS = 250;
const HTTP_URL = /^https?:\/\/[^\s/?#]+/i; // the server re-validates scheme + host
const FIELD_LABEL = {
  title: "제목", category: "분류", summary: "요약", keywords: "키워드", standard_no: "규격번호",
  source_name: "출처 이름", source_url: "원문 링크", status: "상태",
};

function safeUrl(url) {
  const u = typeof url === "string" ? url.trim() : "";
  return HTTP_URL.test(u) ? u : null;
}

/** Server message, plus the offending field names for a 422 validation error. */
function formError(err) {
  const fields = err?.detail?.fields;
  if (err?.status === 422 && Array.isArray(fields) && fields.length) {
    const names = [...new Set(fields.map((f) => FIELD_LABEL[String(f).split(".")[0]] || f))];
    return `${describeError(err)} (${names.join(", ")})`;
  }
  return describeError(err);
}

function categoryName(item) {
  return item.category_label || CATEGORY_LABEL[item.category] || item.category;
}

function staleBadge() {
  return badge("검토 필요", "warn", "alert");
}

export async function renderKnowledge(root, { query, signal, onCleanup }) {
  const isAdmin = store.has("admin");
  const q = {
    text: (query.q || "").trim(),
    category: CATEGORY_LABEL[query.category] ? query.category : "",
    archived: isAdmin && query.archived === "1",
  };
  let data = null;
  let listSeq = 0;
  let recentSeq = 0;

  const disclaimer = h("p", { hidden: true });
  const searchInput = h("input", {
    class: "input", type: "search", value: q.text, placeholder: "제목·키워드·규격번호", "aria-label": "법령·규격 검색",
    autocomplete: "off", enterkeyhint: "search", maxlength: 100,
  });
  const searchForm = h("form", { role: "search" }, searchInput);
  const categoryWrap = h("div");
  const archivedWrap = isAdmin ? h("div", { class: "btn-row" }) : null;
  const recentBody = h("div");
  // Plain wrapper: [hidden] only wins over elements without a display rule.
  const recentSlot = h("div", { hidden: true },
    h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", null, "최근 본 항목"), h("span", { class: "section-note" }, "원문을 연 순서 · 최대 5건")),
      recentBody));
  const listTitle = h("h2", null, "전체 항목");
  const listNote = h("span", { class: "section-note num" });
  const listEl = h("div");
  const addBtn = isAdmin
    ? h("button", { class: "btn btn-primary", type: "button", onClick: () => openEditor(null) }, icon("plus"), "항목 추가")
    : null;

  root.append(h("section", { class: "page" },
    h("header", { class: "page-head" }, h("div", null, h("h1", null, "법령·규격")), h("div", { class: "head-actions" }, addBtn)),
    h("div", { class: "callout callout-warn", role: "note" }, icon("alert"),
      h("div", null, disclaimer, h("p", null, "법령 전문은 저장하지 않습니다. 요약·출처·확인일·원문 링크만 관리합니다."))),
    h("div", { class: "section" }, searchForm, categoryWrap, archivedWrap),
    recentSlot,
    h("section", { class: "section" }, h("div", { class: "section-head" }, listTitle, listNote), listEl),
    h("p", { class: "field-hint" }, "한국전기공사협회 링크는 공식 주소 확인 전까지 추가하지 않습니다.")));

  // ---------------------------------------------------------------- filters

  function isFiltered() {
    return Boolean(q.text || q.category);
  }

  function renderFilters() {
    fill(categoryWrap, chips({
      label: "분류", value: q.category, options: [{ value: "", label: "전체" }, ...CATEGORIES],
      onChange: (v) => { q.category = v; setQuery({ category: v || undefined }); load(); },
    }));
    if (archivedWrap) {
      fill(archivedWrap, h("span", { class: "field-label" }, "보관 항목"), seg({
        label: "보관 항목 표시", value: q.archived ? "1" : "",
        options: [{ value: "", label: "숨김" }, { value: "1", label: "함께 보기" }],
        onChange: (v) => { q.archived = v === "1"; setQuery({ archived: v || undefined }); load(); },
      }));
    }
  }

  function applySearch() {
    if (signal.aborted) return; // a pending debounce must not touch the next route's URL
    const text = searchInput.value.trim();
    if (text === q.text) return;
    q.text = text;
    setQuery({ q: text || undefined });
    load();
  }

  function resetFilters() {
    q.text = "";
    q.category = "";
    searchInput.value = "";
    setQuery({ q: undefined, category: undefined });
    renderFilters();
    load();
    searchInput.focus();
  }

  searchInput.addEventListener("input", debounce(applySearch, SEARCH_DELAY_MS));
  searchForm.addEventListener("submit", (e) => { e.preventDefault(); applySearch(); });

  // ---------------------------------------------------------------- views

  function recordView(item) {
    // Fire-and-forget: the link opens in a new tab and is never held up by this.
    api.post(`api/knowledge/${item.id}/view`)
      .then(() => { if (!signal.aborted) loadRecent(); })
      .catch((err) => console.warn("knowledge view not recorded", item.id, err));
  }

  function bindView(link, item) {
    link.addEventListener("click", () => recordView(item));
    link.addEventListener("auxclick", (e) => { if (e.button === 1) recordView(item); });
    return link;
  }

  function sourceLink(item, url) {
    return bindView(h("a", { class: "btn btn-sm", href: url, target: "_blank", rel: "noopener noreferrer" },
      icon("external"), "원문 열기", h("span", { class: "sr" }, ` — ${item.title}, 새 창`)), item);
  }

  // ---------------------------------------------------------------- recent

  function recentRow(item) {
    const url = safeUrl(item.source_url);
    const inner = [
      h("div", { class: "row-main" }, h("span", { class: "row-title" }, item.title),
        h("span", { class: "row-sub" }, `${categoryName(item)} · ${item.source_name} · 확인일 ${item.verified_at}`)),
      h("div", { class: "row-side" }, item.stale ? staleBadge() : null, url ? badge("원문 열기", "accent", "external") : null),
    ];
    if (!url) return h("li", null, h("div", { class: "row" }, inner));
    return h("li", null, bindView(h("a", { class: "row", href: url, target: "_blank", rel: "noopener noreferrer" },
      inner, h("span", { class: "sr" }, "(새 창)")), item));
  }

  async function loadRecent() {
    const mine = ++recentSeq;
    try {
      const res = await api.get("api/knowledge/recent", {}, { signal });
      if (mine !== recentSeq) return;
      recentSlot.hidden = !res.items.length;
      fill(recentBody, res.items.length ? h("ul", { class: "list" }, res.items.map(recentRow)) : null);
    } catch (err) {
      if (err.name === "AbortError" || mine !== recentSeq) return;
      recentSlot.hidden = false;
      fill(recentBody, h("div", { class: "state state-compact state-error", role: "alert" },
        h("p", null, `최근 본 항목을 불러오지 못했습니다 — ${describeError(err)}`),
        h("button", { class: "btn btn-sm", type: "button", onClick: () => loadRecent() }, "다시 시도")));
    }
  }

  // ---------------------------------------------------------------- list

  function itemCard(item) {
    const url = safeUrl(item.source_url);
    const actions = h("div", { class: "btn-row" },
      url ? sourceLink(item, url) : h("span", { class: "field-error" }, "원문 링크가 올바르지 않습니다"));
    if (isAdmin) {
      const verifyBtn = h("button", { class: "btn btn-sm", type: "button" }, icon("check"), "확인 완료");
      verifyBtn.addEventListener("click", () => inlineConfirm(verifyBtn, {
        message: "원문을 직접 확인했나요? 확인일을 오늘로 바꿉니다.",
        confirmLabel: "확인 완료",
        danger: false,
        onConfirm: async () => {
          await api.post(`api/knowledge/${item.id}/verify`);
          toast(`“${item.title}” 확인일을 오늘로 바꿨습니다.`);
          load();
          loadRecent();
        },
      }));
      append(actions, [h("button", { class: "btn btn-sm", type: "button", onClick: () => openEditor(item) }, icon("pen"), "편집"),
        verifyBtn]);
    }
    return h("article", { class: "card card-flat section" },
      h("div", { class: "btn-row" }, badge(categoryName(item), "accent"),
        item.standard_no ? h("span", { class: "mono dim" }, item.standard_no) : null,
        item.status === "archived" ? badge("보관됨", "", "lock") : null),
      h("h3", null, item.title),
      item.summary ? h("p", { class: "dim" }, item.summary) : null,
      item.keywords?.length ? h("p", { class: "btn-row" }, h("span", { class: "sr" }, "키워드:"), item.keywords.map((k) => badge(k))) : null,
      h("p", { class: "section-note" }, `출처: ${item.source_name} · 확인일 ${item.verified_at}`),
      item.stale ? h("p", { class: "btn-row" }, staleBadge(), h("span", { class: "dim" }, `검토 기한 ${item.review_due_at} 지남`)) : null,
      actions);
  }

  function noMatchState() {
    const terms = [q.text ? `“${q.text}”` : null, q.category ? CATEGORY_LABEL[q.category] : null].filter(Boolean).join(" · ");
    return emptyState({
      title: "조건에 맞는 항목이 없습니다",
      text: `${terms} 조건으로 찾은 항목이 없습니다.`,
      action: h("button", { class: "btn btn-sm", type: "button", onClick: resetFilters }, "검색 초기화"),
    });
  }

  function noDataState() {
    return emptyState({
      title: "등록된 항목이 없습니다",
      text: isAdmin
        ? `공식 원문 링크와 요약을 등록하세요.${q.archived ? "" : " 보관한 항목은 ‘보관 항목 · 함께 보기’에서 보입니다."}`
        : "관리자가 항목을 등록하면 여기에 보입니다.",
      action: isAdmin
        ? h("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => openEditor(null) }, icon("plus"), "항목 추가")
        : null,
    });
  }

  function renderList() {
    if (data.disclaimer) {
      fill(disclaimer, h("strong", null, data.disclaimer));
      disclaimer.hidden = false;
    }
    const items = data.items;
    const stale = items.filter((i) => i.stale).length;
    listTitle.textContent = isFiltered() ? "검색 결과" : "전체 항목";
    listNote.textContent = `${items.length}건${stale ? ` · 검토 필요 ${stale}건` : ""}`;
    if (!items.length) {
      fill(listEl, isFiltered() ? noMatchState() : noDataState());
      return;
    }
    fill(listEl, h("div", { class: "grid-2" }, items.map(itemCard)));
  }

  async function load() {
    const mine = ++listSeq;
    if (!data) fill(listEl, loadingState(4));
    listEl.setAttribute("aria-busy", "true");
    try {
      const res = await api.get("api/knowledge", {
        q: q.text || undefined,
        category: q.category || undefined,
        include_archived: q.archived ? "true" : undefined,
      }, { signal });
      if (mine !== listSeq) return;
      data = res;
      renderList();
    } catch (err) {
      if (err.name === "AbortError" || mine !== listSeq) return;
      listNote.textContent = "";
      fill(listEl, errorState(err, () => load()));
    } finally {
      if (mine === listSeq) listEl.removeAttribute("aria-busy");
    }
  }

  // ---------------------------------------------------------------- admin editor

  function openEditor(item) {
    const editing = Boolean(item);
    let category = item?.category || q.category || CATEGORIES[0].value;
    let status = item?.status || "active";
    const title = h("input", { class: "input", value: item?.title || "", maxlength: 120, required: true });
    const standardNo = h("input", { class: "input", value: item?.standard_no || "", maxlength: 60, placeholder: "예: KEC 232.3" });
    const sourceName = h("input", { class: "input", value: item?.source_name || "", maxlength: 80, required: true,
      placeholder: "예: 국가법령정보센터" });
    const sourceUrl = h("input", { class: "input", type: "url", value: item?.source_url || "", maxlength: 500, required: true,
      placeholder: "https://", autocomplete: "off", spellcheck: "false" });
    const summary = h("textarea", { class: "textarea", maxlength: 1000 }, item?.summary || "");
    const keywords = h("input", { class: "input", value: (item?.keywords || []).join(", "), placeholder: "예: 접지, 정기검사" });
    const err = h("p", { class: "field-error", role: "alert", hidden: true });
    const byField = { title, standard_no: standardNo, source_name: sourceName, source_url: sourceUrl, summary, keywords };
    const byCode = { title_required: title, source_required: sourceName, bad_url: sourceUrl };
    const wide = (el) => { el.classList.add("span-all"); return el; };

    function showError(message, input) {
      Object.values(byField).forEach((el) => el.removeAttribute("aria-invalid"));
      err.textContent = message;
      err.hidden = false;
      if (input) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    }

    const cancel = h("button", { class: "btn", type: "button" }, "취소");
    const save = h("button", { class: "btn btn-primary", type: "button" }, editing ? "저장" : "추가");
    const sheet = openSheet({
      title: editing ? "항목 편집" : "항목 추가",
      wide: true,
      body: [h("div", { class: "form-grid" },
        wide(field("제목", title)),
        h("div", { class: "field span-all" }, h("span", { class: "field-label" }, "분류"),
          chips({ label: "분류", value: category, options: CATEGORIES, onChange: (v) => { category = v; } })),
        field("규격번호", standardNo, "없으면 비워 둡니다"),
        field("출처 이름", sourceName),
        wide(field("원문 링크", sourceUrl, "http:// 또는 https:// 로 시작하는 공식 원문 주소")),
        wide(field("요약", summary, "찾아보기용 요약만 — 전문은 붙여 넣지 않습니다")),
        wide(field("키워드", keywords, "쉼표로 구분")),
        editing ? h("div", { class: "field span-all" }, h("span", { class: "field-label" }, "상태"),
          seg({ label: "상태", value: status, options: [{ value: "active", label: "사용" }, { value: "archived", label: "보관" }],
            onChange: (v) => { status = v; } }),
          h("p", { class: "field-hint" }, "보관하면 목록과 최근 본 항목에서 빠집니다.")) : null),
      err],
      actions: [cancel, save],
    });
    cancel.addEventListener("click", () => sheet.close());

    save.addEventListener("click", async () => {
      const body = {
        title: title.value.trim(),
        category,
        summary: summary.value.trim(),
        keywords: keywords.value.split(/[,，、\n]/).map((k) => k.trim()).filter(Boolean),
        standard_no: standardNo.value.trim(),
        source_name: sourceName.value.trim(),
        source_url: sourceUrl.value.trim(),
        status,
      };
      if (!body.title) { showError("제목을 입력하세요.", title); return; }
      if (!body.source_name) { showError("출처 이름을 입력하세요.", sourceName); return; }
      if (!safeUrl(body.source_url)) { showError("원문 링크는 http:// 또는 https:// 로 시작하는 주소여야 합니다.", sourceUrl); return; }
      save.disabled = true;
      try {
        if (editing) await api.patch(`api/knowledge/${item.id}`, body);
        else await api.post("api/knowledge", body);
        const archivedNow = editing && status === "archived" && item.status !== "archived";
        toast(!editing ? "항목을 추가했습니다."
          : archivedNow ? (q.archived ? "보관했습니다." : "보관했습니다. ‘보관 항목 · 함께 보기’에서 다시 볼 수 있습니다.")
            : "저장했습니다.");
        sheet.close();
        load();
        loadRecent();
      } catch (e) {
        save.disabled = false;
        const firstField = String(e?.detail?.fields?.[0] || "").split(".")[0];
        showError(formError(e), byCode[e?.code] || byField[firstField] || null);
      }
    });
    title.focus();
  }

  // ---------------------------------------------------------------- start

  onCleanup(on("rev", () => { load(); loadRecent(); }));
  renderFilters();
  await Promise.all([load(), loadRecent()]);
}
