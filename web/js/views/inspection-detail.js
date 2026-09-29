// Submitted inspection: frozen record, evidence, review / approval actions,
// findings with their fixes, correction chain and the approved PDF.
import { api } from "../api.js";
import { fill, h, icon } from "../dom.js";
import { fmtDateTime, localDate } from "../lib/format.js";
import { navigate } from "../router.js";
import { drafts, uuid } from "../offline/sync.js";
import { on, store } from "../store.js";
import { badge, describeError, dueBadge, emptyState, errorState, field, inspectionBadge, loadingState, toast } from "../ui.js";

const RESULT = { good: ["양호", "ok"], bad: ["불량", "danger"], na: ["해당없음", ""] };

function attachmentThumb(a) {
  if (a.mime.startsWith("image/")) {
    return h("a", { class: "thumb", href: a.url, target: "_blank", rel: "noopener" }, h("img", { src: a.url, alt: a.filename, loading: "lazy" }));
  }
  return h("a", { class: "thumb", href: a.url, target: "_blank", rel: "noopener" }, icon("file"), a.mime.startsWith("video/") ? "동영상" : "파일");
}

export async function renderInspection(root, { params, signal, onCleanup }) {
  const page = h("section", { class: "page page-narrow" }, loadingState(4));
  root.append(page);

  async function load() {
    let d;
    try {
      d = await api.get(`api/inspections/${params.id}`, {}, { signal });
    } catch (err) {
      if (err.name === "AbortError") return;
      fill(page, err.status === 404 ? emptyState({ title: "점검을 찾을 수 없습니다",
        action: h("a", { class: "btn btn-sm", href: "#/inspect?tab=records" }, "제출 기록") }) : errorState(err, load));
      return;
    }
    if (d.status === "draft") {
      fill(page, emptyState({ title: "아직 제출되지 않은 점검입니다", text: "작성 중인 점검은 작성한 기기에서 이어서 쓰거나 가져올 수 있습니다.",
        action: h("a", { class: "btn btn-sm", href: "#/inspect?tab=drafts" }, "작성·동기화") }));
      return;
    }
    const today = localDate();
    const lastReview = d.reviews[d.reviews.length - 1];
    const report = d.reports[d.reports.length - 1];
    const byItem = (key) => d.attachments.filter((a) => a.owner_type === "inspection_item" && a.item_key === key);
    const general = d.attachments.filter((a) => a.owner_type === "inspection");
    const signature = d.attachments.find((a) => a.owner_type === "signature");
    const itemComments = lastReview?.item_comments || {};

    // --- actions by role and state
    const actions = [];
    if (store.has("reviewer") && d.status === "submitted" && d.inspector_id !== store.user.id) actions.push(reviewPanel(d));
    if (store.has("admin") && report?.status === "pending") actions.push(approvalPanel(report));
    const correctable = ["submitted", "rejected", "reviewed", "approved"].includes(d.status) && !d.corrected_by_id
      && store.has("admin", "worker");
    if (correctable) {
      const btn = h("button", { class: "btn", type: "button" }, icon("pen"), "정정본 작성");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const corr = await api.post(`api/inspections/${d.id}/corrections`, { client_id: uuid() });
          const local = await drafts.fromServer(corr, { review_notes: lastReview && lastReview.decision === "rejected" ? lastReview : null });
          navigate(`/draft/${local.local_id}`);
        } catch (err) {
          toast(describeError(err), { tone: "error" });
          btn.disabled = false;
        }
      });
      actions.push(h("div", { class: "btn-row" }, btn, h("span", { class: "field-hint" }, "원본은 고정된 채로 남고, 정정본이 새 기록으로 연결됩니다.")));
    }

    const integrityOut = h("span", { class: "field-hint", role: "status" });
    const integrityBtn = h("button", { class: "btn btn-sm", type: "button" }, "무결성 확인");
    integrityBtn.addEventListener("click", async () => {
      try {
        const r = await api.get(`api/inspections/${d.id}/integrity`);
        integrityOut.textContent = r.ok ? "원본과 일치합니다 (해시 재계산 결과 동일)." : "주의: 저장된 해시와 다시 계산한 해시가 다릅니다.";
      } catch (err) {
        integrityOut.textContent = describeError(err);
      }
    });

    const sections = new Map();
    d.items.forEach((it) => {
      if (!sections.has(it.section)) sections.set(it.section, []);
      sections.get(it.section).push(it);
    });
    const itemRows = [...sections].map(([name, items]) => h("section", { class: "section" }, name ? h("h3", null, name) : null,
      h("ul", { class: "list" }, items.map((it) => {
        const [label, tone] = RESULT[it.result] || ["미판정", ""];
        const ev = byItem(it.item_key);
        return h("li", null, h("div", { class: "section" },
          h("div", { class: "row" }, h("div", { class: "row-main" }, h("span", { class: "row-title" }, it.label),
            it.memo ? h("span", { class: "dim" }, it.memo) : null,
            it.gps_lat ? h("span", { class: "field-hint" }, `위치 ${it.gps_lat.toFixed(5)}, ${it.gps_lng.toFixed(5)}`) : null),
          h("div", { class: "row-side" }, badge(label, tone, it.result === "bad" ? "x" : it.result === "good" ? "check" : null))),
          itemComments[it.item_key] ? h("p", { class: "callout callout-warn" }, icon("alert"), `검토 의견: ${itemComments[it.item_key]}`) : null,
          ev.length ? h("div", { class: "evidence" }, ev.map(attachmentThumb)) : null));
      }))));

    const findings = d.findings.map((f) => {
      const canResolve = f.status === "open" && (store.has("admin") || f.assignee_id === store.user.id) && store.has("admin", "worker");
      const note = h("textarea", { class: "textarea", placeholder: "조치 내용 (예: 단자 교체 후 토크 확인)", maxlength: 2000 });
      const go = h("button", { class: "btn btn-primary btn-sm", type: "button" }, "조치 완료 등록");
      go.addEventListener("click", async () => {
        if (!note.value.trim()) { toast("조치 내용을 입력하세요.", { tone: "error" }); return; }
        go.disabled = true;
        try {
          await api.post(`api/findings/${f.id}/resolve`, { note: note.value });
          toast("조치 완료로 등록했습니다.");
          load();
        } catch (err) {
          toast(describeError(err), { tone: "error" });
          go.disabled = false;
        }
      });
      return h("li", null, h("div", { class: "section" },
        h("div", { class: "row" }, h("div", { class: "row-main" }, h("span", { class: "row-title" }, f.item_label || f.item_key),
          h("span", { class: "dim" }, f.description), h("span", { class: "row-sub" }, `담당 ${f.assignee_name} · 기한 ${f.due_date || "없음"}`)),
        h("div", { class: "row-side" }, f.status === "resolved" ? badge("조치 완료", "ok", "check") : dueBadge(f.due_date, today, false))),
        f.status === "resolved" ? h("p", { class: "field-hint" }, `조치: ${f.resolution_note} · ${fmtDateTime(f.resolved_at)}`) : null,
        f.task_id ? h("a", { href: `#/board?site=${d.site_id}`, class: "field-hint" }, "후속 업무는 보드에 있습니다 →") : null,
        canResolve ? h("div", { class: "section" }, field("조치 내용", note), h("div", null, go)) : null));
    });

    fill(page, 
      h("header", { class: "page-head" }, h("div", null, h("h1", null, d.asset_name),
        h("p", { class: "page-sub" }, `${d.site_name} · ${d.asset_location || ""} · 점검 ${d.inspector_name} · 제출 ${fmtDateTime(d.submitted_at)}`)),
      h("div", { class: "head-actions" }, inspectionBadge(d.status))),
      d.chain.length > 1 ? h("nav", { class: "btn-row", "aria-label": "정정 이력" }, h("span", { class: "dim" }, "정정 이력:"),
        d.chain.map((c, i) => (c.id === d.id ? badge(i === 0 ? `원본 #${c.id}` : `정정 #${c.id}`, "accent")
          : h("a", { class: "btn btn-sm", href: `#/inspections/${c.id}` }, i === 0 ? `원본 #${c.id}` : `정정 #${c.id}`)))) : null,
      d.corrected_by_id ? h("div", { class: "callout" }, icon("info"), h("span", null, "이 기록은 정정되었습니다. ",
        h("a", { href: `#/inspections/${d.corrected_by_id}` }, `정정본 #${d.corrected_by_id} 보기`))) : null,
      lastReview ? h("div", { class: `callout${lastReview.decision === "rejected" ? " callout-danger" : ""}` }, icon(lastReview.decision === "rejected" ? "alert" : "check"),
        h("div", null, h("strong", null, `${lastReview.decision === "rejected" ? "반려" : "검토 통과"} · ${lastReview.reviewer_name} · ${fmtDateTime(lastReview.created_at)}`),
          lastReview.comment ? h("p", null, lastReview.comment) : null)) : null,
      actions,
      report ? h("section", { class: "card section" }, h("div", { class: "section-head" }, h("h2", null, `보고서 v${report.version}`),
        report.status === "approved" ? badge("승인", "ok", "check") : report.status === "pending" ? badge("승인 대기", "warn") : badge("반려", "danger", "x")),
      h("dl", { class: "facts" }, h("dt", null, "승인 요청"), h("dd", null, `${report.requested_by_name} · ${fmtDateTime(report.requested_at)}`),
        report.decided_at ? [h("dt", null, report.status === "approved" ? "승인" : "반려"), h("dd", null, `${report.decided_by_name} · ${fmtDateTime(report.decided_at)}`)] : null,
        report.decision_comment ? [h("dt", null, "의견"), h("dd", null, report.decision_comment)] : null),
      report.status === "approved" ? h("div", null, h("a", { class: "btn btn-primary", href: `api/reports/${report.id}/pdf`, target: "_blank", rel: "noopener" },
        icon("file"), "PDF 보고서 열기")) : null) : null,
      h("section", { class: "card section" }, h("h2", null, "기록 정보"),
        h("dl", { class: "facts" },
          h("dt", null, "점검 서식"), h("dd", null, `${d.template.name} v${d.template.version}`, d.template.is_sample ? [" ", badge("예시 서식", "warn")] : null),
          h("dt", null, "서명자"), h("dd", null, d.signer_name || "—"),
          h("dt", null, "현장 위치"), h("dd", null, d.gps_lat !== null && d.gps_lat !== undefined ? `${d.gps_lat.toFixed(5)}, ${d.gps_lng.toFixed(5)} (±${Math.round(d.gps_accuracy || 0)}m)` : "기록 없음"),
          h("dt", null, "종합 의견"), h("dd", null, d.summary_note || "—"),
          h("dt", null, "원본 해시"), h("dd", null, h("span", { class: "hash" }, d.content_hash))),
        h("div", { class: "btn-row" }, integrityBtn, integrityOut)),
      h("section", { class: "section" }, h("h2", null, `점검 항목 ${d.items.length}개 · 불량 ${d.bad_count}`), itemRows),
      general.length ? h("section", { class: "section" }, h("h2", null, "전체 첨부"), h("div", { class: "evidence" }, general.map(attachmentThumb))) : null,
      h("section", { class: "section" }, h("h2", null, "지적사항"), findings.length ? h("ul", { class: "list" }, findings) : h("p", { class: "mute" }, "지적사항 없음")),
      signature ? h("section", { class: "section" }, h("h2", null, "전자서명"), h("img", { class: "sig-img", src: signature.url, alt: `${d.signer_name} 서명` })) : null,
      d.reviews.length > 1 ? h("details", { class: "fold" }, h("summary", null, "검토 이력", h("span", { class: "section-note" }, `${d.reviews.length}건`)),
        h("div", { class: "fold-body" }, h("ul", { class: "list" }, d.reviews.map((r) => h("li", null, h("div", { class: "row" },
          h("div", { class: "row-main" }, h("span", { class: "row-title" }, `${r.decision === "rejected" ? "반려" : "검토 통과"} · ${r.reviewer_name}`),
            h("span", { class: "row-sub" }, `${fmtDateTime(r.created_at)} · ${r.comment || ""}`)))))))) : null,
    );
  }

  function reviewPanel(d) {
    const comment = h("textarea", { class: "textarea", maxlength: 2000, placeholder: "검토 의견 (반려 시 필수)" });
    const itemInputs = d.items.filter((it) => it.result === "bad" || it.memo).map((it) => {
      const input = h("input", { class: "input input-sm", maxlength: 300, placeholder: "항목 의견 (선택)", dataset: { key: it.item_key } });
      return field(it.label, input);
    });
    const send = async (decision, btn) => {
      if (decision === "rejected" && !comment.value.trim()) { toast("반려 사유를 입력하세요.", { tone: "error" }); comment.focus(); return; }
      const item_comments = {};
      itemInputs.forEach((f) => { const i = f.querySelector("input"); if (i.value.trim()) item_comments[i.dataset.key] = i.value; });
      btn.disabled = true;
      try {
        await api.post(`api/inspections/${d.id}/review`, { decision, comment: comment.value, item_comments });
        toast(decision === "rejected" ? "반려했습니다. 작성자가 정정본을 올립니다." : "검토를 마치고 보고서 승인을 요청했습니다.");
        load();
      } catch (err) {
        toast(describeError(err), { tone: "error" });
        btn.disabled = false;
      }
    };
    const reject = h("button", { class: "btn btn-danger", type: "button" }, "반려");
    const pass = h("button", { class: "btn btn-primary", type: "button" }, "검토 통과 · 승인 요청");
    reject.addEventListener("click", () => send("rejected", reject));
    pass.addEventListener("click", () => send("reviewed", pass));
    return h("section", { class: "card section" }, h("h2", null, "검토"), field("검토 의견", comment),
      itemInputs.length ? h("details", { class: "inline" }, h("summary", null, "항목별 의견 달기"), h("div", { class: "section" }, itemInputs)) : null,
      h("div", { class: "btn-row" }, reject, pass));
  }

  function approvalPanel(report) {
    const comment = h("textarea", { class: "textarea", maxlength: 2000, placeholder: "승인 의견 (반려 시 필수)" });
    const decide = async (decision, btn) => {
      if (decision === "reject" && !comment.value.trim()) { toast("반려 사유를 입력하세요.", { tone: "error" }); comment.focus(); return; }
      btn.disabled = true;
      try {
        await api.post(`api/reports/${report.id}/approve`, { decision, comment: comment.value });
        toast(decision === "approve" ? "승인했습니다. PDF 보고서가 만들어졌습니다." : "보고서를 반려했습니다.");
        load();
      } catch (err) {
        toast(describeError(err), { tone: "error" });
        btn.disabled = false;
      }
    };
    const reject = h("button", { class: "btn btn-danger", type: "button" }, "반려");
    const approve = h("button", { class: "btn btn-primary", type: "button" }, "승인하고 PDF 발행");
    reject.addEventListener("click", () => decide("reject", reject));
    approve.addEventListener("click", () => decide("approve", approve));
    return h("section", { class: "card section" }, h("h2", null, `보고서 v${report.version} 승인`),
      h("p", { class: "field-hint" }, "승인하면 승인자·시각·버전·원본 해시가 감사 로그와 PDF에 남습니다."),
      field("의견", comment), h("div", { class: "btn-row" }, reject, approve));
  }

  // Live refresh, but never wipe a comment the user is typing.
  onCleanup(on("rev", () => {
    const typing = [...page.querySelectorAll("textarea, input")].some((el) => el.value.trim());
    if (!typing) load();
  }));
  await load();
}
