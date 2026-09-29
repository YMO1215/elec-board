// Checklist runner for one device draft. Every change is written to the
// device first (IndexedDB), so nothing is lost when the connection drops.
import { api } from "../api.js";
import { debounce, fill, h, icon } from "../dom.js";
import { addDays, fileSize, fmtDateTime, fmtTime, localDate } from "../lib/format.js";
import { navigate } from "../router.js";
import { drafts, keepLocal, queueSubmit, saveRemote, takeServer, uuid } from "../offline/sync.js";
import { on, store } from "../store.js";
import { badge, describeError, emptyState, field, loadingState, personTag, pick, toast } from "../ui.js";
import { draftBadge } from "./inspect.js";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const RESULTS = [
  { value: "good", label: "양호", icon: "check", cls: "j-good" },
  { value: "bad", label: "불량", icon: "x", cls: "j-bad" },
  { value: "na", label: "해당없음", icon: "minus", cls: "j-na" },
];
const RESULT_LABEL = { good: "양호", bad: "불량", na: "해당없음" };

function position() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("이 기기는 위치 기록을 지원하지 않습니다.")); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? "위치 권한이 거부되었습니다. 브라우저 설정에서 허용하세요." : "위치를 가져오지 못했습니다.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

function gpsText(lat, lng, acc) {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}${acc ? ` (±${Math.round(acc)}m)` : ""}`;
}

export async function renderDraft(root, { params, onCleanup }) {
  const page = h("section", { class: "page page-narrow" }, loadingState(4));
  root.append(page);
  let d = await drafts.get(params.id).catch(() => null);
  if (!d) {
    fill(page, emptyState({ title: "이 기기에 없는 점검입니다",
      text: "이미 제출되어 서버로 올라갔거나 다른 기기에서 작성한 점검입니다.",
      action: h("a", { class: "btn btn-sm", href: "#/inspect?tab=drafts" }, "작성·동기화 목록") }));
    return;
  }
  const urls = [];
  onCleanup(() => urls.forEach((u) => URL.revokeObjectURL(u)));
  const savedNote = h("span", { class: "dim", role: "status" });
  let showSummary = false;

  const persist = debounce(async () => {
    try {
      d = await drafts.save(d);
      savedNote.textContent = `기기에 저장됨 ${fmtTime(d.updated_at)}`;
      pushRemote();
    } catch (err) {
      savedNote.textContent = `기기 저장 실패: ${describeError(err)}`;
    }
  }, 250);
  const pushRemote = debounce(async () => {
    if (!store.online || d.status !== "editing") return;
    try {
      d = await saveRemote(d);
      if (d.status === "conflict") render();
    } catch { /* server copy is best-effort; the device copy is the source until submit */ }
  }, 4000);

  const locked = () => d.status === "queued" || d.status === "syncing";

  function thumb(ev) {
    let media;
    if (ev.remote_url) media = ev.type.startsWith("image/") ? h("img", { src: ev.remote_url, alt: ev.name }) : h("span", null, ev.name);
    else media = h("span", null, "…");
    const el = h("div", { class: "thumb", title: `${ev.name} · ${fileSize(ev.size)}` }, media);
    if (ev.blob_key) {
      drafts.getBlob(ev.blob_key).then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        fill(el, ev.type.startsWith("video/") ? h("video", { src: url, muted: true }) : ev.type.startsWith("image/")
          ? h("img", { src: url, alt: ev.name }) : h("span", null, ev.name), removeBtn());
      });
    } else {
      el.append(removeBtn());
    }
    function removeBtn() {
      if (locked()) return "";
      return h("button", { class: "btn btn-sm btn-icon", type: "button", "aria-label": `${ev.name} 삭제`, onClick: async () => {
        if (ev.uploaded_id) {
          try { await api.del(`api/attachments/${ev.uploaded_id}`); } catch (err) { toast(describeError(err), { tone: "error" }); return; }
        }
        d.evidence = d.evidence.filter((x) => x !== ev);
        persist();
        render();
      } }, icon("x"));
    }
    return el;
  }

  function evidenceInput(itemKey) {
    const input = h("input", { type: "file", accept: "image/*,video/*", capture: "environment", multiple: true,
      "aria-label": "사진·동영상 첨부" });
    input.addEventListener("change", async () => {
      for (const file of input.files) {
        if (file.size > MAX_FILE_BYTES) { toast(`${file.name}: 50MB를 넘는 파일은 첨부할 수 없습니다.`, { tone: "error" }); continue; }
        const key = uuid();
        try {
          await drafts.putBlob(key, file);
        } catch (err) {
          toast(`기기에 저장하지 못했습니다: ${describeError(err)}`, { tone: "error" });
          continue;
        }
        d.evidence.push({ client_id: uuid(), item_key: itemKey, name: file.name || "capture.jpg", type: file.type || "image/jpeg",
          size: file.size, blob_key: key, uploaded_id: null });
      }
      persist();
      render();
    });
    return h("label", { class: "btn btn-sm file-label" }, icon("camera"), "사진·동영상", input);
  }

  function itemCard(it, reviewComment) {
    const answered = Boolean(it.result);
    const judge = h("div", { class: "judge", role: "radiogroup", "aria-label": `${it.label} 판정` });
    RESULTS.forEach((r) => {
      const id = `${it.item_key}-${r.value}`;
      const input = h("input", { type: "radio", name: `j-${it.item_key}`, id, value: r.value, checked: it.result === r.value, disabled: locked() });
      input.addEventListener("change", () => {
        it.result = r.value;
        persist();
        render(it.item_key);
      });
      judge.append(input, h("label", { for: id, class: r.cls }, icon(r.icon), r.label));
    });
    const memo = h("textarea", { class: "textarea", maxlength: 2000, disabled: locked(),
      placeholder: it.result === "bad" ? "불량 내용 (필수) — 지적사항과 후속 업무로 넘어갑니다" : "메모 (측정값 등)" }, it.memo);
    memo.addEventListener("input", () => { it.memo = memo.value; persist(); });
    const memoOpen = it.result === "bad" || it.memo;
    const memoToggle = h("button", { class: "btn btn-sm btn-ghost", type: "button", hidden: memoOpen || locked() }, "메모 추가");
    const memoField = h("div", { hidden: !memoOpen }, field(it.result === "bad" ? "불량 내용" : "메모", memo));
    memoToggle.addEventListener("click", () => { memoField.hidden = false; memoToggle.hidden = true; memo.focus(); });
    const gpsBtn = h("button", { class: "btn btn-sm", type: "button", disabled: locked() }, icon("pin"), it.gps_lat ? "위치 다시 기록" : "위치 기록");
    gpsBtn.addEventListener("click", async () => {
      gpsBtn.disabled = true;
      try {
        const p = await position();
        it.gps_lat = p.lat;
        it.gps_lng = p.lng;
        persist();
        render(it.item_key);
      } catch (err) {
        toast(err.message, { tone: "error" });
        gpsBtn.disabled = false;
      }
    });
    const ev = d.evidence.filter((e) => e.item_key === it.item_key);
    return h("article", { class: `card check-item${answered ? "" : " is-unanswered"}`, id: `item-${it.item_key}` },
      h("div", { class: "check-item-head" }, h("h3", null, it.label), answered ? badge(RESULT_LABEL[it.result],
        it.result === "good" ? "ok" : it.result === "bad" ? "danger" : "") : badge("미판정")),
      reviewComment ? h("p", { class: "callout callout-warn" }, icon("alert"), `검토 의견: ${reviewComment}`) : null,
      judge,
      memoField,
      h("div", { class: "btn-row" }, locked() ? null : evidenceInput(it.item_key), gpsBtn, memoToggle,
        it.gps_lat ? h("span", { class: "field-hint" }, gpsText(it.gps_lat, it.gps_lng)) : null),
      ev.length ? h("div", { class: "evidence" }, ev.map(thumb)) : null);
  }

  function conflictBanner() {
    const server = d.conflict;
    const byKey = Object.fromEntries((server?.items || []).map((i) => [i.item_key, i]));
    const diffs = d.items.filter((it) => {
      const s = byKey[it.item_key];
      return s && (s.result !== it.result || (s.memo || "") !== (it.memo || ""));
    });
    return h("section", { class: "section card", role: "alert" },
      h("div", { class: "callout callout-danger" }, icon("alert"), h("div", null, h("strong", null, "다른 기기에서 저장한 내용과 다릅니다."),
        h("p", null, "어느 쪽을 남길지 고르세요. 고르기 전에는 제출되지 않습니다."))),
      diffs.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", null, "항목"), h("th", null, "이 기기"), h("th", null, "서버"))),
        h("tbody", null, diffs.map((it) => h("tr", null, h("td", null, it.label),
          h("td", null, `${RESULT_LABEL[it.result] || "미판정"}${it.memo ? ` · ${it.memo}` : ""}`),
          h("td", null, `${RESULT_LABEL[byKey[it.item_key].result] || "미판정"}${byKey[it.item_key].memo ? ` · ${byKey[it.item_key].memo}` : ""}`))))))
        : h("p", { class: "dim" }, "판정은 같고 메모·저장 순서만 다릅니다."),
      h("div", { class: "btn-row" },
        h("button", { class: "btn", type: "button", onClick: async () => { d = await takeServer(d); render(); } }, "서버 내용으로 바꾸기"),
        h("button", { class: "btn btn-primary", type: "button", onClick: async () => { d = await keepLocal(d); render(); pushRemote(); } }, "이 기기 내용 유지")));
  }

  function statusBanner() {
    if (d.status === "conflict") return conflictBanner();
    if (d.status === "queued" || d.status === "syncing") {
      return h("div", { class: "banner banner-info", role: "status" }, icon("sync"),
        h("span", null, store.online ? "서버에 올리는 중입니다…" : "동기화 대기 — 연결되면 자동으로 제출됩니다. 이 화면을 닫아도 됩니다."),
        d.error ? h("span", { class: "dim" }, `(${d.error})`) : null);
    }
    if (d.status === "error") {
      return h("div", { class: "banner", role: "alert" }, icon("alert"), h("span", null, `제출하지 못했습니다: ${d.error}. 고친 뒤 다시 제출하세요.`));
    }
    return null;
  }

  // ------------------------------------------------------------ summary + signature

  function signaturePad() {
    const canvas = h("canvas", { class: "sig-pad", "aria-label": "서명 영역 — 손가락이나 펜으로 서명" });
    const preview = h("div");
    let drawing = false;
    let dirty = false;
    let ctx = null;
    const setup = () => {
      const r = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(r.width * ratio));
      canvas.height = Math.max(1, Math.round(r.height * ratio));
      ctx = canvas.getContext("2d");
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = getComputedStyle(document.body).color;
    };
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener("pointerdown", (e) => {
      if (!ctx) setup();
      drawing = true;
      dirty = true;
      canvas.setPointerCapture(e.pointerId);
      ctx.beginPath();
      ctx.moveTo(...pos(e));
    });
    canvas.addEventListener("pointermove", (e) => { if (drawing) { ctx.lineTo(...pos(e)); ctx.stroke(); } });
    const end = () => {
      if (!drawing) return;
      drawing = false;
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const key = d.signature?.blob_key || uuid();
        await drafts.putBlob(key, blob);
        d.signature = { client_id: d.signature?.uploaded_id ? uuid() : d.signature?.client_id || uuid(), blob_key: key, uploaded_id: null };
        persist();
      }, "image/png");
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    const clearBtn = h("button", { class: "btn btn-sm", type: "button", onClick: () => {
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      d.signature = null;
      dirty = false;
      fill(preview);
      persist();
    } }, "서명 지우기");
    if (d.signature?.blob_key && !dirty) {
      drafts.getBlob(d.signature.blob_key).then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        fill(preview, h("p", { class: "field-hint" }, "저장된 서명 (다시 그리면 바뀝니다)"), h("img", { class: "sig-img", src: url, alt: "저장된 서명" }));
      });
    }
    return h("div", { class: "section" }, preview, canvas, h("div", null, clearBtn));
  }

  function summarySection() {
    const counts = { good: 0, bad: 0, na: 0 };
    d.items.forEach((i) => { if (i.result) counts[i.result] += 1; });
    const missing = d.items.filter((i) => !i.result);
    const badNoMemo = d.items.filter((i) => i.result === "bad" && !i.memo.trim());
    const bad = d.items.filter((i) => i.result === "bad");
    const slotted = store.slotted();
    const today = localDate();
    const findingRows = bad.map((it) => {
      const opt = d.findings[it.item_key] || (d.findings[it.item_key] = { assignee_id: store.user.board_slot ? store.user.id : slotted[0]?.id, due_date: addDays(today, 7) });
      const due = h("input", { class: "input", type: "date", value: opt.due_date || "", disabled: locked() });
      due.addEventListener("change", () => { opt.due_date = due.value; persist(); });
      return h("div", { class: "card card-flat section" }, h("h4", null, it.label), h("p", { class: "dim" }, it.memo || "(불량 내용 없음)"),
        h("fieldset", null, h("legend", null, "후속 조치 담당"), pick({ label: "후속 조치 담당", value: opt.assignee_id,
          options: slotted.map((m) => ({ value: m.id, node: personTag({ slot: m.board_slot, initials: m.initials, name: m.name }), disabled: locked() })),
          onChange: (v) => { opt.assignee_id = Number(v); persist(); } })),
        field("조치 기한", due));
    });
    const gpsBtn = h("button", { class: "btn btn-sm", type: "button", disabled: locked() }, icon("pin"), d.gps ? "현장 위치 다시 기록" : "현장 위치 기록");
    gpsBtn.addEventListener("click", async () => {
      gpsBtn.disabled = true;
      try { d.gps = await position(); persist(); render(null, true); } catch (err) { toast(err.message, { tone: "error" }); gpsBtn.disabled = false; }
    });
    const note = h("textarea", { class: "textarea", maxlength: 4000, disabled: locked(), placeholder: "종합 의견 (선택)" }, d.summary_note);
    note.addEventListener("input", () => { d.summary_note = note.value; persist(); });
    const signer = h("input", { class: "input", value: d.signer_name, maxlength: 40, disabled: locked() });
    signer.addEventListener("input", () => { d.signer_name = signer.value; persist(); });
    const problems = [];
    if (missing.length) problems.push(`판정하지 않은 항목 ${missing.length}개`);
    if (badNoMemo.length) problems.push(`불량 내용이 빈 항목 ${badNoMemo.length}개`);
    if (!d.signer_name.trim()) problems.push("서명자 이름");
    if (!d.signature) problems.push("전자서명");
    const submitBtn = h("button", { class: "btn btn-primary", type: "button", disabled: locked() }, "제출");
    submitBtn.addEventListener("click", async () => {
      const now = [];
      if (d.items.some((i) => !i.result)) now.push("판정하지 않은 항목");
      if (d.items.some((i) => i.result === "bad" && !i.memo.trim())) now.push("불량 내용");
      if (!d.signer_name.trim()) now.push("서명자 이름");
      if (!d.signature) now.push("전자서명");
      if (now.length) { toast(`제출 전에 채워 주세요: ${now.join(", ")}`, { tone: "error" }); return; }
      submitBtn.disabled = true;
      // Stop pending background saves so they cannot overwrite the queue's copy.
      persist.cancel();
      pushRemote.cancel();
      d = await drafts.save(d);
      await queueSubmit(d);
      const after = await drafts.get(d.local_id);
      if (after) { d = after; render(null, true); }
    });
    return h("section", { class: "section", id: "summary" },
      h("h2", null, "요약 확인"),
      h("div", { class: "stat-row" },
        h("div", { class: "stat" }, h("span", { class: "stat-label" }, "양호"), h("span", { class: "stat-value num" }, String(counts.good))),
        h("div", { class: `stat${counts.bad ? " is-alert" : ""}` }, h("span", { class: "stat-label" }, "불량"), h("span", { class: "stat-value num" }, String(counts.bad))),
        h("div", { class: "stat" }, h("span", { class: "stat-label" }, "해당없음"), h("span", { class: "stat-value num" }, String(counts.na))),
        h("div", { class: "stat" }, h("span", { class: "stat-label" }, "첨부"), h("span", { class: "stat-value num" }, String(d.evidence.length)))),
      missing.length ? h("div", { class: "callout callout-warn" }, icon("alert"), h("div", null, h("strong", null, "판정하지 않은 항목"),
        h("div", { class: "btn-row" }, missing.map((m) => h("a", { class: "btn btn-sm", href: `#/draft/${d.local_id}`, onClick: (e) => {
          e.preventDefault();
          document.getElementById(`item-${m.item_key}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        } }, m.label))))) : null,
      bad.length ? h("section", { class: "section" }, h("h3", null, "지적사항·후속 업무"),
        h("p", { class: "field-hint" }, "불량 항목마다 지적사항과 후속 업무가 자동으로 만들어집니다."), findingRows) : null,
      h("div", { class: "section" }, h("h3", null, "현장 위치"), h("div", { class: "btn-row" }, gpsBtn,
        d.gps ? h("span", { class: "field-hint" }, gpsText(d.gps.lat, d.gps.lng, d.gps.accuracy)) : h("span", { class: "field-hint" }, "선택 — 위치 권한이 없으면 건너뛸 수 있습니다."))),
      field("종합 의견", note),
      field("서명자", signer),
      locked() ? null : signaturePad(),
      problems.length && !locked() ? h("p", { class: "field-error" }, `제출 전 필요: ${problems.join(" · ")}`) : null,
      h("div", { class: "btn-row" }, submitBtn));
  }

  // ------------------------------------------------------------ render

  function render(focusKey = null, keepSummary = false) {
    if (keepSummary) showSummary = true;
    const answered = d.items.filter((i) => i.result).length;
    const sections = [];
    const bySection = new Map();
    d.items.forEach((it) => {
      if (!bySection.has(it.section)) bySection.set(it.section, []);
      bySection.get(it.section).push(it);
    });
    const comments = d.review_notes?.item_comments || {};
    for (const [name, items] of bySection) {
      sections.push(h("section", { class: "section" }, name ? h("h2", null, name) : null, items.map((it) => itemCard(it, comments[it.item_key]))));
    }
    const life = d.asset.life;
    const progress = h("progress", { max: d.items.length, value: answered, "aria-label": `판정 ${answered}/${d.items.length}` });
    const summaryBtn = h("button", { class: "btn btn-primary", type: "button", onClick: () => {
      showSummary = true;
      render(null, true);
      document.getElementById("summary")?.scrollIntoView({ behavior: "smooth" });
    } }, "요약 확인 →");
    fill(page, 
      h("header", { class: "page-head" }, h("div", null,
        h("h1", null, d.asset.name),
        h("p", { class: "page-sub" }, `${d.asset.site_name || ""} · ${d.asset.location || "위치 미입력"} · ${d.template.name} v${d.template.version}`)),
      h("div", { class: "head-actions" }, draftBadge(d))),
      h("div", { class: "btn-row" },
        d.template.is_sample ? badge("예시 서식", "warn") : null,
        d.corrects_id ? badge(`정정본 · 원본 #${d.corrects_id}`, "accent") : null,
        h("span", { class: "dim" }, d.asset.last_inspected_at ? `마지막 점검 ${fmtDateTime(d.asset.last_inspected_at)}` : "이전 점검 기록 없음"),
        life && life.state !== "unknown" ? badge(life.label, life.state === "expired" ? "danger" : life.state === "soon" ? "warn" : "") : null),
      d.review_notes?.comment ? h("div", { class: "callout callout-warn" }, icon("alert"), h("div", null, h("strong", null, "반려 사유"), h("p", null, d.review_notes.comment))) : null,
      statusBanner(),
      h("div", { class: "section" }, h("div", { class: "section-head" }, h("span", { class: "dim" }, "판정 진행"),
        h("span", { class: "num" }, `${answered} / ${d.items.length}`)), progress),
      sections,
      showSummary ? summarySection() : null,
      h("div", { class: "sticky-foot" }, savedNote, showSummary ? null : summaryBtn));
    if (focusKey) {
      document.querySelector(`#item-${focusKey} input:checked`)?.focus();
    }
  }

  onCleanup(on("synced", ({ local_id: id, server_id: serverId }) => {
    if (id === d.local_id) {
      toast("제출했습니다. 서버에 원본이 고정되었습니다.");
      navigate(`/inspections/${serverId}`);
    }
  }));
  onCleanup(on("drafts", async () => {
    const fresh = await drafts.get(d.local_id).catch(() => null);
    if (fresh && fresh.status !== d.status) { d = fresh; render(null, showSummary); }
  }));
  onCleanup(on("online", () => render(null, showSummary)));

  savedNote.textContent = `기기에 저장됨 ${fmtTime(d.updated_at)}`;
  onCleanup(() => {
    persist.cancel();
    pushRemote.cancel();
    // Flush the last keystrokes, but never resurrect a draft the queue already submitted.
    drafts.get(d.local_id).then((stored) => { if (stored && stored.status === "editing" && d.status === "editing") drafts.save(d); })
      .catch(() => {});
  });
  render();
  if (d.status === "conflict") page.querySelector("[role=alert]")?.scrollIntoView();
}
