"""Local Bridge サーバーの試験（long-poll と版の表現）。

実行: python3 -m pytest tests/test_bridge_server.py -q

注意: Bridge は ~/.itera/roots.json を読み書きする。実運用の登録を壊さないよう、
      すべての試験で CONFIG_DIR / ROOTS_FILE / MACHINE_FILE を一時ディレクトリへ差し替える。
      （過去に、使い捨てサーバーが実運用の状態ファイルを共有して汚した事故がある）
"""

import importlib.util
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]
SERVER_PY = REPO / "vfs_root" / "system" / "services" / "itera_bridge_server.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("itera_bridge_server", SERVER_PY)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["itera_bridge_server"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def srv(tmp_path):
    """隔離した状態ファイルを持つサーバーと、ルート1つ。"""
    mod = _load_module()
    cfg = tmp_path / "dot_itera"
    mod.CONFIG_DIR = cfg
    mod.ROOTS_FILE = cfg / "roots.json"
    mod.MACHINE_FILE = cfg / "machine.json"

    root_dir = tmp_path / "root_a"
    root_dir.mkdir()
    (root_dir / "a.txt").write_text("hello", encoding="utf-8")

    bridge = mod.Bridge(exec_enabled=False)
    name = bridge.add_root(str(root_dir), name="root_a")
    scanner = bridge.scanner(name)
    scanner.scan()

    client = TestClient(mod.build_app(bridge))
    return {"mod": mod, "bridge": bridge, "scanner": scanner, "client": client, "dir": root_dir}


def _bump(srv, text):
    """ホスト側で中身を変えて再走査する（rev が上がる）。"""
    (srv["dir"] / "a.txt").write_text(text, encoding="utf-8")
    srv["scanner"].scan()


# ---------- 版の表現 ----------

def test_status_advertises_longpoll_and_token(srv):
    body = srv["client"].get("/api/status").json()
    assert body["longPoll"] is True
    assert isinstance(body["revToken"], str) and body["revToken"]


def test_status_keeps_old_keys(srv):
    """旧 OS 側が読む鍵を落とさない（互換）。"""
    body = srv["client"].get("/api/status").json()
    for key in ("version", "execEnabled", "roots", "ignorePatterns", "hostname"):
        assert key in body, key


def test_rev_token_changes_when_content_changes(srv):
    before = srv["bridge"].rev_token()
    _bump(srv, "changed")
    assert srv["bridge"].rev_token() != before


def test_rev_token_stable_when_nothing_changes(srv):
    before = srv["bridge"].rev_token()
    srv["scanner"].scan()
    assert srv["bridge"].rev_token() == before


def test_rev_token_changes_when_root_added(srv, tmp_path):
    before = srv["bridge"].rev_token()
    other = tmp_path / "root_b"
    other.mkdir()
    srv["bridge"].add_root(str(other), name="root_b")
    assert srv["bridge"].rev_token() != before


# ---------- long-poll ----------

def test_longpoll_returns_as_soon_as_rev_changes(srv):
    token = srv["bridge"].rev_token()
    with ThreadPoolExecutor(max_workers=1) as pool:
        started = time.monotonic()
        fut = pool.submit(srv["client"].get, f"/api/status?wait=10&since={token}")
        time.sleep(0.5)
        _bump(srv, "changed")
        body = fut.result(timeout=10).json()
        elapsed = time.monotonic() - started
    assert body["revToken"] != token
    assert 0.4 <= elapsed < 5.0, f"変更に追随していない: {elapsed:.2f}s"


def test_longpoll_holds_until_timeout_when_quiet(srv):
    token = srv["bridge"].rev_token()
    started = time.monotonic()
    body = srv["client"].get(f"/api/status?wait=1&since={token}").json()
    elapsed = time.monotonic() - started
    assert body["revToken"] == token
    assert elapsed >= 0.9, f"待たずに返った: {elapsed:.2f}s"
    # 上限としても効くこと。ここを見ないと min→max の取り違えを見逃す。
    assert elapsed < 3.0, f"頼んだ秒数を超えて待った: {elapsed:.2f}s"


def test_longpoll_returns_immediately_for_stale_since(srv):
    started = time.monotonic()
    srv["client"].get("/api/status?wait=10&since=root_a:999")
    assert time.monotonic() - started < 1.0


def test_longpoll_returns_immediately_without_since(srv):
    """初回（since を持たない）で待たせない。ここで待つと起動が 25 秒遅れる。"""
    started = time.monotonic()
    srv["client"].get("/api/status?wait=10")
    assert time.monotonic() - started < 1.0


def test_plain_status_never_waits(srv):
    started = time.monotonic()
    srv["client"].get("/api/status")
    assert time.monotonic() - started < 1.0
