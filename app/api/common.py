"""Query parsing shared by routers."""
from __future__ import annotations

from datetime import date, timedelta

from ..db import local_today
from ..errors import bad_request
from ..services.kpi import Period
from ..services.tasks import KINDS, PRIORITIES, TaskFilter

MAX_PERIOD_DAYS = 366


def parse_date(value: str | None, field: str) -> date | None:
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise bad_request(f"{field} 날짜 형식은 YYYY-MM-DD 입니다.", "bad_date", {"field": field})


def task_filter(site_id: int | None, assignee_id: int | None, priority: str | None,
                due_from: str | None, due_to: str | None, kind: str | None = None) -> TaskFilter:
    if priority is not None and priority not in PRIORITIES:
        raise bad_request("우선순위 값이 올바르지 않습니다.", "bad_priority")
    if kind is not None and kind not in KINDS:
        raise bad_request("업무 종류 값이 올바르지 않습니다.", "bad_kind")
    return TaskFilter(site_id=site_id, assignee_id=assignee_id, priority=priority,
                      due_from=parse_date(due_from, "due_from"), due_to=parse_date(due_to, "due_to"), kind=kind)


def period(start: str | None, end: str | None, tz) -> Period:
    s, e = parse_date(start, "start"), parse_date(end, "end")
    if s is None or e is None:
        today = local_today(tz)
        s = today.replace(day=1)
        next_month = (s + timedelta(days=32)).replace(day=1)
        e = next_month - timedelta(days=1)
    if e < s:
        raise bad_request("기간의 끝이 시작보다 앞설 수 없습니다.", "bad_period")
    if (e - s).days + 1 > MAX_PERIOD_DAYS:
        raise bad_request("기간은 최대 1년입니다.", "bad_period")
    return Period(s, e)
