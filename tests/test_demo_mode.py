"""Demo hosts (Vercel) run several instances, each with its own /tmp DB.
A login made on one instance must be accepted by another."""
from fastapi.testclient import TestClient

from app.demo import DEMO_PASSWORD, seed_demo
from app.main import create_app

from .conftest import make_settings


def _instance(tmp_path, name, demo=True):
    settings = make_settings(tmp_path / name, demo_mode=demo)
    seed_demo(settings)
    return create_app(settings)


def test_session_survives_instance_switch(tmp_path):
    a, b = _instance(tmp_path, "a"), _instance(tmp_path, "b")
    ca = TestClient(a)
    me = ca.post("/api/auth/login", json={"email": "admin@demo.local", "password": DEMO_PASSWORD}).json()["me"]
    cookie = ca.cookies.get("eb_session")
    cb = TestClient(b, cookies={"eb_session": cookie})
    state = cb.get("/api/auth/state").json()
    assert state["demo"] is True and state["me"]["user"]["email"] == "admin@demo.local"
    assert cb.get("/api/tasks/board").status_code == 200
    # Writes on the other instance still need the CSRF token carried in the signed session.
    r = cb.patch("/api/tasks/1/status", json={"status": "in_progress"}, headers={"X-CSRF-Token": me["csrf"]})
    assert r.status_code == 200
    assert cb.patch("/api/tasks/1/status", json={"status": "review"}, headers={"X-CSRF-Token": "x"}).status_code == 403


def test_tampered_or_non_demo_tokens_are_rejected(tmp_path):
    a = _instance(tmp_path, "a")
    ca = TestClient(a)
    ca.post("/api/auth/login", json={"email": "field1@demo.local", "password": DEMO_PASSWORD})
    token = ca.cookies.get("eb_session")
    forged = token.replace("s1.2.", "s1.1.", 1)  # try to become user 1 (admin)
    assert TestClient(a, cookies={"eb_session": forged}).get("/api/auth/state").json()["me"] is None
    real = _instance(tmp_path, "real", demo=False)
    assert TestClient(real, cookies={"eb_session": token}).get("/api/auth/state").json()["me"] is None
