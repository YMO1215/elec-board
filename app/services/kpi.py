"""KPI calculation. Each metric is computed from one row list, and both the
summary counts and the drilldown come from that same list, so the numbers on
screen can always be traced back to concrete records."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Callable

from .. import audit
from ..db import bump_rev, local_date_of, many, now_iso
from ..deps import Actor
from ..errors import bad_request

DEFAULT_DEFINITIONS = [
    {
        "key": "inspection_completion", "name": "점검 완료율",
        "description": "기한이 기간 안에 있는 점검 업무 중 점검 기록이 제출된 비율",
        "numerator_label": "점검 기록이 제출된 점검 업무", "denominator_label": "기한이 기간 안에 있는 점검 업무",
        "target": 95, "weight": 30,
    },
    {
        "key": "on_time", "name": "정시 완료율",
        "description": "기간 안에 완료된 업무 중 기한 내에 끝난 비율 (기한이 없는 업무는 제외)",
        "numerator_label": "기한 내 완료 업무", "denominator_label": "기간 안에 완료된 업무(기한 있음)",
        "target": 90, "weight": 30,
    },
    {
        "key": "finding_resolution", "name": "지적 조치율",
        "description": "기간 안에 발견된 지적 중 현재까지 조치 완료된 비율",
        "numerator_label": "조치 완료 지적", "denominator_label": "기간 안에 발견된 지적",
        "target": 90, "weight": 20,
    },
    {
        "key": "report_approval", "name": "보고서 승인율",
        "description": "기간 안에 승인 요청(제출)된 보고서 중 승인된 비율",
        "numerator_label": "승인 보고서", "denominator_label": "기간 안에 제출된 보고서",
        "target": 95, "weight": 20,
    },
]
WEIGHT_TOTAL = 100.0
NEAR_TARGET_POINTS = 10.0
TREND_PERIODS = 6


@dataclass(frozen=True)
class Period:
    start: date
    end: date  # inclusive

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    def previous(self) -> "Period":
        end = self.start - timedelta(days=1)
        return Period(end - timedelta(days=self.days - 1), end)

    def utc_bounds(self, tz) -> tuple[str, str]:
        lo = datetime.combine(self.start, time.min, tz).astimezone(timezone.utc)
        hi = datetime.combine(self.end + timedelta(days=1), time.min, tz).astimezone(timezone.utc)
        return lo.isoformat(timespec="seconds"), hi.isoformat(timespec="seconds")

    def as_dict(self) -> dict[str, str]:
        return {"start": self.start.isoformat(), "end": self.end.isoformat()}


def ensure_definitions(conn, org_id: int) -> None:
    for pos, d in enumerate(DEFAULT_DEFINITIONS):
        conn.execute(
            "INSERT OR IGNORE INTO kpi_definitions (org_id, key, name, description, numerator_label,"
            " denominator_label, unit, good_direction, target, weight, position)"
            " VALUES (?, ?, ?, ?, ?, ?, '%', 'up', ?, ?, ?)",
            (org_id, d["key"], d["name"], d["description"], d["numerator_label"], d["denominator_label"],
             d["target"], d["weight"], pos),
        )


def definitions(conn, org_id: int) -> list[dict[str, Any]]:
    return many(conn, "SELECT * FROM kpi_definitions WHERE org_id = ? ORDER BY position", (org_id,))


# --- row sources (one per metric) -------------------------------------------

def _inspection_completion(conn, org_id, period: Period, user_id, tz):
    sql = (
        "SELECT t.id, t.title, t.due_date, t.status, s.name AS site_name, u.name AS assignee_name,"
        " EXISTS (SELECT 1 FROM inspections i WHERE i.task_id = t.id"
        "   AND i.status IN ('submitted','reviewed','approved')) AS in_numerator"
        " FROM tasks t JOIN sites s ON s.id = t.site_id JOIN users u ON u.id = t.primary_assignee_id"
        " WHERE t.org_id = ? AND t.kind = 'inspection' AND t.due_date BETWEEN ? AND ?"
    )
    params: list[Any] = [org_id, period.start.isoformat(), period.end.isoformat()]
    if user_id:
        sql += " AND t.primary_assignee_id = ?"
        params.append(user_id)
    return [{**r, "type": "task", "label": r["title"], "when": r["due_date"],
             "in_numerator": bool(r["in_numerator"])} for r in many(conn, sql + " ORDER BY t.due_date", params)]


def _on_time(conn, org_id, period: Period, user_id, tz):
    lo, hi = period.utc_bounds(tz)
    sql = (
        "SELECT t.id, t.title, t.due_date, t.completed_at, s.name AS site_name, u.name AS assignee_name"
        " FROM tasks t JOIN sites s ON s.id = t.site_id JOIN users u ON u.id = t.primary_assignee_id"
        " WHERE t.org_id = ? AND t.status = 'done' AND t.due_date IS NOT NULL"
        " AND t.completed_at >= ? AND t.completed_at < ?"
    )
    params: list[Any] = [org_id, lo, hi]
    if user_id:
        sql += " AND t.primary_assignee_id = ?"
        params.append(user_id)
    out = []
    for r in many(conn, sql + " ORDER BY t.completed_at", params):
        done_on = local_date_of(r["completed_at"], tz).isoformat()
        out.append({**r, "type": "task", "label": r["title"], "when": done_on,
                    "in_numerator": done_on <= r["due_date"]})
    return out


def _finding_resolution(conn, org_id, period: Period, user_id, tz):
    lo, hi = period.utc_bounds(tz)
    sql = (
        "SELECT f.id, f.description, f.status, f.created_at, f.resolved_at, f.task_id, f.inspection_id,"
        " s.name AS site_name, u.name AS assignee_name"
        " FROM findings f JOIN sites s ON s.id = f.site_id JOIN users u ON u.id = f.assignee_id"
        " WHERE f.org_id = ? AND f.created_at >= ? AND f.created_at < ?"
    )
    params: list[Any] = [org_id, lo, hi]
    if user_id:
        sql += " AND f.assignee_id = ?"
        params.append(user_id)
    return [{**r, "type": "finding", "label": r["description"], "when": local_date_of(r["created_at"], tz).isoformat(),
             "in_numerator": r["status"] == "resolved"} for r in many(conn, sql + " ORDER BY f.created_at", params)]


def _report_approval(conn, org_id, period: Period, user_id, tz):
    lo, hi = period.utc_bounds(tz)
    sql = (
        "SELECT r.id, r.version, r.status, r.requested_at, r.inspection_id, a.name AS asset_name,"
        " s.name AS site_name, u.name AS assignee_name"
        " FROM reports r JOIN inspections i ON i.id = r.inspection_id JOIN assets a ON a.id = i.asset_id"
        " JOIN sites s ON s.id = i.site_id JOIN users u ON u.id = i.inspector_id"
        " WHERE r.org_id = ? AND r.requested_at >= ? AND r.requested_at < ?"
    )
    params: list[Any] = [org_id, lo, hi]
    if user_id:
        sql += " AND i.inspector_id = ?"
        params.append(user_id)
    return [{**r, "type": "report", "label": f"{r['asset_name']} 보고서 v{r['version']}",
             "when": local_date_of(r["requested_at"], tz).isoformat(),
             "in_numerator": r["status"] == "approved"} for r in many(conn, sql + " ORDER BY r.requested_at", params)]


SOURCES: dict[str, Callable] = {
    "inspection_completion": _inspection_completion,
    "on_time": _on_time,
    "finding_resolution": _finding_resolution,
    "report_approval": _report_approval,
}


def _ratio(rows: list[dict[str, Any]]) -> tuple[int, int, float | None]:
    den = len(rows)
    num = sum(1 for r in rows if r["in_numerator"])
    # Zero denominator is "no data", shown as "—", never 0%.
    return num, den, (round(num / den * 100, 1) if den else None)


def achievement(value: float | None, target: float, direction: str) -> float | None:
    if value is None or target <= 0:
        return None
    if direction == "up":
        return round(min(value / target * 100, 100.0), 1)
    return round(min(target / value * 100, 100.0), 1) if value > 0 else 100.0


def judgement(value: float | None, target: float, direction: str) -> str:
    if value is None:
        return "no_data"
    gap = (value - target) if direction == "up" else (target - value)
    if gap >= 0:
        return "met"
    return "near" if gap >= -NEAR_TARGET_POINTS else "below"


def _metric_values(conn, org_id: int, period: Period, user_id: int | None, tz) -> dict[str, tuple]:
    return {key: _ratio(src(conn, org_id, period, user_id, tz)) for key, src in SOURCES.items()}


def weighted(metrics: list[dict[str, Any]]) -> float | None:
    usable = [m for m in metrics if m["achievement"] is not None and m["weight"] > 0]
    total_w = sum(m["weight"] for m in usable)
    if not usable or total_w <= 0:
        return None
    return round(sum(m["achievement"] * m["weight"] for m in usable) / total_w, 1)


def summary(conn, org_id: int, period: Period, user_id: int | None, tz) -> dict[str, Any]:
    defs = definitions(conn, org_id)
    current = _metric_values(conn, org_id, period, user_id, tz)
    prev_period = period.previous()
    previous = _metric_values(conn, org_id, prev_period, user_id, tz)
    trend_periods = [period]
    for _ in range(TREND_PERIODS - 1):
        trend_periods.insert(0, trend_periods[0].previous())
    trend_values = [_metric_values(conn, org_id, p, user_id, tz) for p in trend_periods]

    metrics = []
    for d in defs:
        num, den, value = current[d["key"]]
        _, _, prev_value = previous[d["key"]]
        metrics.append({
            "key": d["key"],
            "name": d["name"],
            "description": d["description"],
            "numerator_label": d["numerator_label"],
            "denominator_label": d["denominator_label"],
            "unit": d["unit"],
            "good_direction": d["good_direction"],
            "target": d["target"],
            "weight": d["weight"],
            "numerator": num,
            "denominator": den,
            "value": value,
            "achievement": achievement(value, d["target"], d["good_direction"]),
            "judgement": judgement(value, d["target"], d["good_direction"]),
            "previous_value": prev_value,
            "delta": round(value - prev_value, 1) if value is not None and prev_value is not None else None,
            "trend": [{"start": p.start.isoformat(), "end": p.end.isoformat(), "value": tv[d["key"]][2],
                       "numerator": tv[d["key"]][0], "denominator": tv[d["key"]][1]}
                      for p, tv in zip(trend_periods, trend_values)],
        })
    return {
        "scope": "user" if user_id else "team",
        "user_id": user_id,
        "period": period.as_dict(),
        "baseline": {"kind": "previous_period", "label": "직전 동일 기간", **prev_period.as_dict()},
        "target_source": "관리자 설정 목표",
        "metrics": metrics,
        "weighted": weighted(metrics),
        "weighted_rule": "Σ(지표 달성률 × 가중치) ÷ Σ(가중치), 달성률 상한 100%, 데이터 없는 지표 제외",
        "computed_at": now_iso(),
    }


def drilldown(conn, org_id: int, metric: str, period: Period, user_id: int | None, tz) -> dict[str, Any]:
    if metric not in SOURCES:
        raise bad_request("알 수 없는 지표입니다.", "unknown_metric")
    rows = SOURCES[metric](conn, org_id, period, user_id, tz)
    num, den, value = _ratio(rows)
    items = [{"type": r["type"], "id": r["id"], "label": r["label"], "when": r["when"],
              "site_name": r["site_name"], "assignee_name": r["assignee_name"],
              "in_numerator": r["in_numerator"],
              "link_id": r.get("inspection_id") if r["type"] in ("report", "finding") else r["id"]}
             for r in rows]
    return {"metric": metric, "period": period.as_dict(), "numerator": num, "denominator": den,
            "value": value, "items": items, "computed_at": now_iso()}


def update_definitions(conn, actor: Actor, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    actor.require("admin")
    before = {d["key"]: d for d in definitions(conn, actor.org_id)}
    incoming = {i["key"]: i for i in items}
    if set(incoming) != set(before):
        raise bad_request("모든 지표의 목표와 가중치를 함께 보내야 합니다.", "incomplete_definitions")
    for i in incoming.values():
        if not (0 < float(i["target"]) <= 100):
            raise bad_request("목표는 0 초과 100 이하입니다.", "bad_target", {"key": i["key"]})
        if float(i["weight"]) < 0:
            raise bad_request("가중치는 0 이상입니다.", "bad_weight", {"key": i["key"]})
    total = sum(float(i["weight"]) for i in incoming.values())
    if abs(total - WEIGHT_TOTAL) > 1e-6:
        raise bad_request(f"가중치 합계가 {WEIGHT_TOTAL:g}이어야 합니다 (현재 {total:g}).", "weights_sum",
                          {"total": total})
    changes = {}
    for key, i in incoming.items():
        old = before[key]
        if float(old["target"]) != float(i["target"]) or float(old["weight"]) != float(i["weight"]):
            changes[key] = {"target": [old["target"], float(i["target"])],
                            "weight": [old["weight"], float(i["weight"])]}
            conn.execute("UPDATE kpi_definitions SET target = ?, weight = ? WHERE org_id = ? AND key = ?",
                         (float(i["target"]), float(i["weight"]), actor.org_id, key))
    if changes:
        audit.record(conn, actor.org_id, actor.user_id, "kpi.definitions", "kpi_definitions", None, changes)
        bump_rev(conn, actor.org_id)
    return definitions(conn, actor.org_id)


def save_snapshot(conn, actor: Actor, payload: dict[str, Any]) -> dict[str, Any]:
    actor.require("admin")
    cur = conn.execute(
        "INSERT INTO kpi_snapshots (org_id, scope, user_id, period_start, period_end, payload_json,"
        " created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (actor.org_id, payload["scope"], payload["user_id"], payload["period"]["start"],
         payload["period"]["end"], json.dumps(payload, ensure_ascii=False), actor.user_id, now_iso()),
    )
    audit.record(conn, actor.org_id, actor.user_id, "kpi.snapshot", "kpi_snapshot", cur.lastrowid,
                 {"period": payload["period"], "scope": payload["scope"], "weighted": payload["weighted"]})
    return {"id": cur.lastrowid}


def list_snapshots(conn, org_id: int) -> list[dict[str, Any]]:
    out = many(conn, "SELECT s.id, s.scope, s.user_id, s.period_start, s.period_end, s.created_at,"
                     " s.payload_json, u.name AS created_by_name FROM kpi_snapshots s"
                     " JOIN users u ON u.id = s.created_by WHERE s.org_id = ? ORDER BY s.id DESC LIMIT 50",
               (org_id,))
    for r in out:
        payload = json.loads(r.pop("payload_json"))
        r["weighted"] = payload.get("weighted")
    return out
