"""Local Bridge サーバーの試験（接続用トークン。serve --require-token）。

実行: python3 -m pytest tests/guest/test_bridge_server_token.py -q

前半はプロセスの中（TestClient）、後半は本物のサーバーと CLI を別プロセスで起こして叩く。
どちらも設定の置き場を一時ディレクトリへ差し替える（実運用の ~/.itera を読まない・書かない）。
港は空いている番号をその場で取る（稼働中のサーバーの港に触らない）。
"""

import importlib.util
import json
import os
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
SERVER_PY = REPO / "vfs_root" / "system" / "services" / "itera_bridge_server.py"
ORIGIN = "https://itera.example"


def _load_module():
    spec = importlib.util.spec_from_file_location("itera_bridge_server", SERVER_PY)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["itera_bridge_server"] = mod
    spec.loader.exec_module(mod)
    return mod


def _make(tmp_path, require_token):
    mod = _load_module()
    cfg = tmp_path / "dot_itera"
    mod.CONFIG_DIR = cfg
    mod.ROOTS_FILE = cfg / "roots.json"
    mod.MACHINE_FILE = cfg / "machine.json"

    root_dir = tmp_path / "root_a"
    root_dir.mkdir()
    (root_dir / "a.txt").write_text("hello", encoding="utf-8")

    token = mod.ensure_token()[0] if require_token else None
    # exec は入れておく（関門が無ければ本当に走る形で、断られることを見る）。
    bridge = mod.Bridge(exec_enabled=True, require_token=require_token)
    bridge.add_root(str(root_dir), name="root_a")
    bridge.scanner("root_a").scan()
    app = mod.build_app(bridge)
    return {
        "mod": mod, "cfg": cfg, "bridge": bridge, "app": app,
        "client": TestClient(app), "dir": root_dir, "token": token,
    }


@pytest.fixture()
def open_srv(tmp_path):
    """旗を立てていないサーバー（既定）。"""
    return _make(tmp_path, require_token=False)


@pytest.fixture()
def locked(tmp_path):
    """トークン必須のサーバー。"""
    return _make(tmp_path, require_token=True)


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


# ---------- 既定（旗なし）は今までどおり ----------

def test_default_lets_anyone_in_and_creates_no_token(open_srv):
    res = open_srv["client"].get("/api/status")
    assert res.status_code == 200
    assert res.json()["tokenRequired"] is False
    assert not (open_srv["cfg"] / "token").exists()


def test_default_ignores_a_token_that_is_sent(open_srv):
    res = open_srv["client"].get("/api/status", headers=_bearer("anything"))
    assert res.status_code == 200


# ---------- 必須のとき ----------

def test_missing_token_is_401_and_tells_nothing_about_the_host(locked):
    res = locked["client"].get("/api/status")
    assert res.status_code == 401
    body = res.json()
    assert body["code"] == "token_required"
    assert body["tokenRequired"] is True
    # ホスト名・利用者名・machineId・ルートの実パスを、通していない相手に見せない
    assert set(body) == {"detail", "code", "tokenRequired"}
    assert res.headers["www-authenticate"] == "Bearer"


def test_wrong_token_is_401_invalid(locked):
    res = locked["client"].get("/api/status", headers=_bearer(locked["token"] + "x"))
    assert res.status_code == 401
    assert res.json()["code"] == "token_invalid"


def test_prefix_of_the_token_is_not_enough(locked):
    res = locked["client"].get("/api/status", headers=_bearer(locked["token"][:-1]))
    assert res.status_code == 401


def test_other_scheme_with_the_right_value_is_refused(locked):
    res = locked["client"].get("/api/status", headers={"Authorization": f"Basic {locked['token']}"})
    assert res.status_code == 401
    assert res.json()["code"] == "token_invalid"


def test_right_token_gets_in(locked):
    res = locked["client"].get("/api/status", headers=_bearer(locked["token"]))
    assert res.status_code == 200
    body = res.json()
    assert body["tokenRequired"] is True
    assert body["roots"][0]["name"] == "root_a"


def test_every_route_is_behind_the_gate(locked):
    """道を 1 本ずつ数える。新しい道を足したときも、関門の外に出ていれば落ちる。"""
    seen = set()
    for route in locked["app"].routes:
        path = getattr(route, "path", None)
        if not path:
            continue
        url = path.replace("{root}", "root_a").replace("{name}", "root_a").replace("{rel:path}", "a.txt")
        for method in sorted(getattr(route, "methods", None) or []):
            res = locked["client"].request(method, url)
            assert res.status_code == 401, f"{method} {path} -> {res.status_code}"
            seen.add((method, path))
    for must in [
        ("POST", "/api/exec"),
        ("POST", "/api/roots"),
        ("DELETE", "/api/roots/{name}"),
        ("PUT", "/api/{root}/file/{rel:path}"),
        ("DELETE", "/api/{root}/file/{rel:path}"),
        ("GET", "/docs"),
        ("GET", "/openapi.json"),
    ]:
        assert must in seen, must
    # 断られた要求は何も変えていない
    assert (locked["dir"] / "a.txt").read_text(encoding="utf-8") == "hello"
    assert list(locked["bridge"].state["roots"]) == ["root_a"]


def test_refused_requests_do_not_run(locked):
    marker = locked["dir"] / "ran.txt"
    res = locked["client"].post(
        "/api/exec", json={"command": f"touch {marker}", "scope": "host"}
    )
    assert res.status_code == 401
    assert not marker.exists()
    res = locked["client"].post("/api/roots", json={"path": str(locked["dir"].parent), "name": "sneaked"})
    assert res.status_code == 401
    assert "sneaked" not in locked["bridge"].state["roots"]


# ---------- ブラウザから見えること（CORS） ----------

def test_preflight_passes_without_a_token(locked):
    res = locked["client"].options(
        "/api/status",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == "*"
    assert "authorization" in res.headers["access-control-allow-headers"].lower()


def test_401_carries_cors_headers(locked):
    """付いていないと、ブラウザの中では 401 ではなく通信の失敗に見える。"""
    res = locked["client"].get("/api/status", headers={"Origin": ORIGIN})
    assert res.status_code == 401
    assert res.headers.get("access-control-allow-origin") == "*"


def test_bare_options_is_not_a_way_around(locked):
    res = locked["client"].options("/api/status")
    assert res.status_code == 401


# ---------- トークンのファイル ----------

def test_token_is_created_once_and_kept(locked):
    mod = locked["mod"]
    again, created = mod.ensure_token()
    assert created is False
    assert again == locked["token"]
    assert len(again) >= 40


@pytest.mark.skipif(os.name != "posix", reason="権限のビットは POSIX だけ")
def test_token_file_is_owner_only(locked):
    mode = stat.S_IMODE((locked["cfg"] / "token").stat().st_mode)
    assert mode == 0o600


def test_rotation_is_picked_up_without_rebuilding(locked):
    mod = locked["mod"]
    old = locked["token"]
    assert locked["client"].get("/api/status", headers=_bearer(old)).status_code == 200
    new, created = mod.ensure_token(rotate=True)
    assert created is True and new != old
    assert locked["client"].get("/api/status", headers=_bearer(old)).status_code == 401
    assert locked["client"].get("/api/status", headers=_bearer(new)).status_code == 200


def test_required_but_unreadable_token_refuses_everyone(locked):
    (locked["cfg"] / "token").unlink()
    assert locked["client"].get("/api/status", headers=_bearer(locked["token"])).status_code == 401
    # 空のトークンどうしが「一致」しない
    assert locked["client"].get("/api/status", headers={"Authorization": "Bearer "}).status_code == 401
    (locked["cfg"] / "token").write_text("\n", encoding="utf-8")
    assert locked["client"].get("/api/status", headers={"Authorization": "Bearer "}).status_code == 401


# ---------- 本物のサーバーと CLI（別プロセス） ----------

def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _http(port, path, token=None, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def _cli(cfg, *args):
    env = dict(os.environ, ITERA_CONFIG_DIR=str(cfg))
    return subprocess.run(
        [sys.executable, str(SERVER_PY), *args], env=env, capture_output=True, text=True, timeout=30
    )


class _Live:
    def __init__(self, tmp_path, *flags):
        self.cfg = tmp_path / "dot_itera_live"
        self.port = _free_port()
        self.log_path = tmp_path / "serve.log"
        self._log = open(self.log_path, "w", encoding="utf-8")
        env = dict(os.environ, ITERA_CONFIG_DIR=str(self.cfg), PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER_PY), "serve", f"--port={self.port}", "--exec=off", *flags],
            env=env, stdout=self._log, stderr=subprocess.STDOUT, cwd=str(tmp_path),
        )
        deadline = time.monotonic() + 30
        while True:
            if self.proc.poll() is not None:
                raise AssertionError("the server exited: " + self.log())
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    break
            except OSError:
                if time.monotonic() > deadline:
                    self.stop()
                    raise AssertionError("the server did not start: " + self.log())
                time.sleep(0.1)

    def log(self):
        self._log.flush()
        return self.log_path.read_text(encoding="utf-8")

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self._log.close()


@pytest.fixture()
def live_open(tmp_path):
    srv = _Live(tmp_path)
    yield srv
    srv.stop()


@pytest.fixture()
def live_locked(tmp_path):
    srv = _Live(tmp_path, "--require-token")
    yield srv
    srv.stop()


def test_serve_without_the_flag_stays_open(live_open):
    code, body = _http(live_open.port, "/api/status")
    assert code == 200
    assert body["tokenRequired"] is False
    assert not (live_open.cfg / "token").exists()
    assert "Token: not required" in live_open.log()


def test_serve_with_the_flag_creates_the_token_and_locks(live_locked):
    token_file = live_locked.cfg / "token"
    token = token_file.read_text(encoding="utf-8").strip()
    assert token
    if os.name == "posix":
        assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
    log = live_locked.log()
    assert "Token: required" in log
    assert token not in log  # トークンそのものをログに出さない

    code, body = _http(live_locked.port, "/api/status")
    assert (code, body["code"]) == (401, "token_required")
    code, body = _http(live_locked.port, "/api/status", token="wrong")
    assert (code, body["code"]) == (401, "token_invalid")
    code, body = _http(live_locked.port, "/api/status", token=token)
    assert code == 200 and body["tokenRequired"] is True


def test_cli_sends_the_token_of_its_own_config_dir(live_locked, tmp_path):
    token = (live_locked.cfg / "token").read_text(encoding="utf-8").strip()
    wanted = tmp_path / "wanted"
    wanted.mkdir()
    port = f"--port={live_locked.port}"

    # 別の設定の置き場（トークンを持たない相手）からは、ルートを足せない
    stranger = tmp_path / "dot_itera_stranger"
    res = _cli(stranger, "attach", str(tmp_path), "--name", "sneaked", port)
    assert res.returncode != 0
    assert "requires a token" in res.stderr
    assert _http(live_locked.port, "/api/roots", token=token)[1]["roots"] == []

    # 違うトークンを持つ相手も同じ
    _cli(stranger, "token")
    res = _cli(stranger, "ls", port)
    assert res.returncode != 0
    assert "requires a token" in res.stderr

    # サーバーと同じ設定の置き場の CLI は通る
    res = _cli(live_locked.cfg, "attach", str(wanted), port)
    assert res.returncode == 0, res.stderr
    res = _cli(live_locked.cfg, "ls", port)
    assert res.returncode == 0, res.stderr
    assert "wanted" in res.stdout
    names = [r["name"] for r in _http(live_locked.port, "/api/roots", token=token)[1]["roots"]]
    assert names == ["wanted"]


def test_token_command_prints_and_rotates(live_locked):
    token = (live_locked.cfg / "token").read_text(encoding="utf-8").strip()
    res = _cli(live_locked.cfg, "token")
    assert res.returncode == 0
    assert res.stdout == token + "\n"  # 標準出力はトークンだけ

    res = _cli(live_locked.cfg, "token", "--rotate")
    assert res.returncode == 0
    new = res.stdout.strip()
    assert new and new != token
    # 走っているサーバーが、再起動なしで新しいトークンに切り替わる
    assert _http(live_locked.port, "/api/status", token=token)[0] == 401
    assert _http(live_locked.port, "/api/status", token=new)[0] == 200


def test_token_command_creates_one_when_missing(tmp_path):
    cfg = tmp_path / "dot_itera_fresh"
    first = _cli(cfg, "token")
    assert first.returncode == 0
    assert "Created" in first.stderr
    second = _cli(cfg, "token")
    assert second.stdout == first.stdout
    assert second.stderr == ""