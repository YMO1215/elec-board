from __future__ import annotations

import io
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app

PASSWORD = "test-pass-1234"


def make_settings(tmp_path: Path, **overrides) -> Settings:
    return Settings(data_dir=tmp_path / "data", secret_key="test-secret", **overrides)


class Api:
    """A logged-in browser: own cookie jar + CSRF header on writes."""

    def __init__(self, app, csrf: str | None = None, client: TestClient | None = None):
        self.client = client or TestClient(app)
        self.csrf = csrf
        self.me: dict[str, Any] | None = None

    def _h(self, headers=None):
        h = dict(headers or {})
        if self.csrf:
            h["X-CSRF-Token"] = self.csrf
        return h

    def get(self, url, **kw):
        return self.client.get(url, **kw)

    def post(self, url, json=None, **kw):
        return self.client.post(url, json=json, headers=self._h(kw.pop("headers", None)), **kw)

    def patch(self, url, json=None, **kw):
        return self.client.patch(url, json=json, headers=self._h(kw.pop("headers", None)), **kw)

    def put(self, url, json=None, **kw):
        return self.client.put(url, json=json, headers=self._h(kw.pop("headers", None)), **kw)

    def delete(self, url, **kw):
        return self.client.delete(url, headers=self._h(kw.pop("headers", None)), **kw)

    @property
    def id(self) -> int:
        return self.me["user"]["id"]


def login(app, email: str, password: str = PASSWORD) -> Api:
    api = Api(app)
    r = api.post("/api/auth/login", {"email": email, "password": password})
    assert r.status_code == 200, r.text
    api.me = r.json()["me"]
    api.csrf = api.me["csrf"]
    return api


def ok(r, status: int = 200):
    assert r.status_code == status, f"{r.status_code}: {r.text}"
    return r.json()


def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (40, 20), (10, 20, 30)).save(buf, format="PNG")
    return buf.getvalue()


def new_key() -> str:
    return str(uuid.uuid4())


@dataclass
class Team:
    app: Any
    settings: Settings
    admin: Api
    worker: Api
    reviewer: Api
    worker2: Api
    site: dict
    asset: dict
    templates: list

    def members(self):
        return [self.admin, self.worker, self.reviewer, self.worker2]


@pytest.fixture()
def settings(tmp_path):
    return make_settings(tmp_path)


@pytest.fixture()
def app(settings):
    return create_app(settings)


def build_team(app, settings) -> Team:
    anon = Api(app)
    r = anon.post("/api/auth/setup", {"org_name": "테스트 전기팀", "name": "김관리", "email": "admin@t.local",
                                      "password": PASSWORD})
    ok(r)
    admin = login(app, "admin@t.local")
    people = {}
    for name, email, roles, slot in [("이작업", "worker@t.local", ["worker"], 2),
                                     ("박검토", "reviewer@t.local", ["reviewer", "worker"], 3),
                                     ("최작업", "worker2@t.local", ["worker"], 4)]:
        inv = ok(admin.post("/api/auth/invite", {"email": email, "name": name, "roles": roles, "board_slot": slot}))
        ok(Api(app).post(f"/api/auth/invite/{inv['token']}/accept", {"password": PASSWORD}))
        people[email] = login(app, email)
    templates = ok(admin.get("/api/templates"))["items"]
    panel = next(t for t in templates if t["asset_type"] == "분전반")
    site = ok(admin.post("/api/sites", {"name": "A동 수변전실", "code": "A"}))
    asset = ok(admin.post("/api/assets", {"site_id": site["id"], "name": "분전반 L-1", "asset_type": "분전반",
                                          "location": "1층", "template_id": panel["id"],
                                          "installed_on": "2015-01-01", "service_life_years": 15}))
    return Team(app, settings, admin, people["worker@t.local"], people["reviewer@t.local"],
                people["worker2@t.local"], site, asset, templates)


@pytest.fixture()
def team(app, settings) -> Team:
    return build_team(app, settings)


def create_task(api: Api, team: Team, assignee: Api, **extra) -> dict:
    body = {"site_id": team.site["id"], "title": extra.pop("title", "분전반 점검"),
            "primary_assignee_id": assignee.id, **extra}
    return ok(api.post("/api/tasks", body))


def submit_inspection(team: Team, inspector: Api, *, task_id=None, results=None, memo_for_bad="단자 변색",
                      findings=None) -> dict:
    """Runs the full device flow: draft -> signature upload -> submit."""
    draft = ok(inspector.post("/api/inspections/drafts", {"client_id": new_key(), "asset_id": team.asset["id"],
                                                          "task_id": task_id}))
    results = results or {}
    items = []
    for it in draft["items"]:
        res = results.get(it["item_key"], "good")
        items.append({"item_key": it["item_key"], "result": res, "memo": memo_for_bad if res == "bad" else ""})
    sig = ok(inspector.post("/api/attachments", files={"file": ("sig.png", png_bytes(), "image/png")},
                            data={"owner_type": "signature", "owner_id": str(draft["id"])}))
    body = {"submit_key": new_key(), "items": items, "signer_name": inspector.me["user"]["name"],
            "signature_attachment_id": sig["id"], "gps": {"lat": 37.5, "lng": 127.0, "accuracy": 10},
            "findings": findings or []}
    return ok(inspector.post(f"/api/inspections/{draft['id']}/submit", body))
