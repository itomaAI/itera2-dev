#!/usr/bin/env python3
"""
itera_bridge_server.py - Itera OS Local Bridge (v3)

ホスト側で動くサーバー兼 CLI。1プロセスで複数のルート（作業ディレクトリ）を扱い、
Itera OS の VFS へ `local/<接続名>/<ルート名>` としてマウントさせる。

    python itera_bridge_server.py serve --port 8001
    python itera_bridge_server.py attach [DIR] [--name NAME] [--port 8001]
    python itera_bridge_server.py detach NAME [--port 8001]
    python itera_bridge_server.py ls [--port 8001]

依存: fastapi, uvicorn, watchdog (任意), requests (CLI のみ)

設計上の約束:
  * ルート一覧は ~/.itera/roots.json に永続化する。プロセスを落としても消えない。
  * シェル実行の「都度確認」は OS 側（ブラウザ）の責務。ホストには UI が無いため、
    サーバーは --exec off という固い遮断だけを持つ。
  * 作業ディレクトリは永続化しない。毎回ルート起点で実行し、実効ディレクトリを返す。
"""

import argparse
import asyncio
import fnmatch
import getpass
import hashlib
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

VERSION = "3.6.0"
# long-poll（変更があるまで応答を保留する）の上限と刻み。
# 刻みは応答の遅れの下限になるので細かく、ただし空回りが目に見えない程度に。
MAX_LONG_POLL_SEC = 60.0
LONG_POLL_STEP_SEC = 0.1
CONFIG_DIR = Path.home() / ".itera"
ROOTS_FILE = CONFIG_DIR / "roots.json"
MACHINE_FILE = CONFIG_DIR / "machine.json"
DEFAULT_IGNORE = [
    ".git", ".venv", "venv", "node_modules", "__pycache__",
    "*.pyc", ".DS_Store", "dist", "build",
]

# --------------------------------------------------------------------------
# 設定の永続化
# --------------------------------------------------------------------------

_state_lock = threading.RLock()


def load_state():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if not ROOTS_FILE.exists():
        return {"roots": {}, "ignorePatterns": list(DEFAULT_IGNORE), "rootIgnore": {}}
    try:
        data = json.loads(ROOTS_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        # 壊れた設定を黙って初期化すると、利用者はルートを失ったことに気づけない。
        raise SystemExit(f"[itera] {ROOTS_FILE} を読めません: {e}")
    data.setdefault("roots", {})
    data.setdefault("ignorePatterns", list(DEFAULT_IGNORE))
    # ルートごとの無視パターン。OS 側（local_bridge デーモン）が接続のたびに送ってくる
    # 「そのルートで実際に効いている一覧」をそのまま保存する（T-0164）。
    # 在るルートでは全体の ignorePatterns より**こちらが優先**（和にしない）。
    # 和にすると、サーバーだけが隠す項目が生まれ、OS 側はそれを「ホストから消えた」と読む。
    if not isinstance(data.get("rootIgnore"), dict):
        data["rootIgnore"] = {}
    return data


def save_state(state):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ROOTS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(ROOTS_FILE)


# --------------------------------------------------------------------------
# 同一性（この機械が誰であるかを名乗る）
# --------------------------------------------------------------------------

_identity_cache = None


def machine_id():
    """この機械を一意に指す ID。~/.itera/machine.json に永続化する。

    URL は同一性の根拠にならない。ssh -L でポート転送すると、転送先が
    どの機械であっても OS からは 127.0.0.1:<port> に見えるためである。
    ホスト名も改名されうるので、区別のための ID は別に持つ。

    壊れた machine.json を黙って作り直すと、この機械が別人として現れ、
    OS 側の同一性照合が「別の機械に繋ぎ替えられた」と誤検出する。
    直せるのは人間だけなので、ここでは失敗させる。
    """
    if MACHINE_FILE.exists():
        try:
            data = json.loads(MACHINE_FILE.read_text(encoding="utf-8"))
        except Exception as e:
            raise SystemExit(f"[itera] {MACHINE_FILE} を読めません: {e}")
        mid = data.get("machineId")
        if isinstance(mid, str) and mid:
            return mid
        raise SystemExit(f"[itera] {MACHINE_FILE} に machineId がありません")
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    mid = str(uuid.uuid4())
    tmp = MACHINE_FILE.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"machineId": mid, "createdAt": int(time.time() * 1000)}, indent=2),
        encoding="utf-8",
    )
    tmp.replace(MACHINE_FILE)
    return mid


def host_identity():
    """起動時に1度だけ確定させる。実行中に名前が変わる方が事故になる。"""
    global _identity_cache
    if _identity_cache is None:
        _identity_cache = {
            "hostname": socket.gethostname(),
            "user": getpass.getuser(),
            "platform": f"{platform.system()} {platform.release()}".strip(),
            "machineId": machine_id(),
        }
    return dict(_identity_cache)


# --------------------------------------------------------------------------
# 走査とメタデータ
# --------------------------------------------------------------------------

class RootScanner:
    """1ルート分の走査結果を保持する。ハッシュは (mtime, size) が変わった時だけ再計算する。"""

    def __init__(self, name, path, ignore_patterns):
        self.name = name
        self.path = Path(path).expanduser().resolve()
        self.ignore = list(ignore_patterns)
        self.meta = {}
        self.tombstones = {}
        self.hash_cache = {}
        self.lock = threading.RLock()
        self.dirty = True
        self.last_scan = 0.0
        # 中身が実際に変わったときだけ増える番号。OS 側はこれを見て調停する。
        # lastScan では駄目で、無変更でも 60 秒ごとに動くため毎回調停してしまう。
        self.rev = 0

    def set_ignore(self, patterns):
        with self.lock:
            self.ignore = list(patterns)
            self.dirty = True

    def is_ignored(self, rel):
        parts = rel.split("/")
        for raw in self.ignore:
            pat = (raw or "").strip()
            if not pat or pat.startswith("#"):
                continue
            if pat.endswith("/"):
                pat = pat[:-1]
            if not pat:
                continue
            if "/" in pat:
                if fnmatch.fnmatch(rel, pat):
                    return True
            else:
                if any(fnmatch.fnmatch(seg, pat) for seg in parts):
                    return True
        return False

    def file_hash(self, abs_path, st):
        key = str(abs_path)
        cached = self.hash_cache.get(key)
        if cached and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
            return cached[2]
        h = hashlib.sha256()
        with open(abs_path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        digest = h.hexdigest()
        self.hash_cache[key] = (st.st_mtime_ns, st.st_size, digest)
        return digest

    def scan(self):
        """フルスキャン。除外ディレクトリは枝刈り段階で捨てる（stat も hash もしない）。"""
        new_meta = {}
        base = self.path
        if not base.is_dir():
            with self.lock:
                self.meta = {}
                self.dirty = False
                self.last_scan = time.time()
            return
        for dirpath, dirnames, filenames in os.walk(base):
            rel_dir = os.path.relpath(dirpath, base).replace(os.sep, "/")
            if rel_dir == ".":
                rel_dir = ""
            kept = []
            for d in dirnames:
                rel = f"{rel_dir}/{d}" if rel_dir else d
                if self.is_ignored(rel):
                    continue
                kept.append(d)
                new_meta[rel] = {
                    "kind": "directory",
                    "size": 0,
                    "updatedAt": int(os.stat(os.path.join(dirpath, d)).st_mtime * 1000),
                    "hash": None,
                }
            dirnames[:] = kept
            for fn in filenames:
                rel = f"{rel_dir}/{fn}" if rel_dir else fn
                if self.is_ignored(rel):
                    continue
                abs_path = os.path.join(dirpath, fn)
                try:
                    st = os.stat(abs_path)
                    new_meta[rel] = {
                        "kind": "file",
                        "size": st.st_size,
                        "updatedAt": int(st.st_mtime * 1000),
                        "hash": self.file_hash(abs_path, st),
                    }
                except (OSError, PermissionError):
                    # 読めない1件で全体を落とさない。ただし黙って消さないため記録もしない。
                    continue
        with self.lock:
            for rel in list(self.tombstones.keys()):
                if rel in new_meta:
                    del self.tombstones[rel]
            if new_meta != self.meta:
                self.rev += 1
            self.meta = new_meta
            self.dirty = False
            self.last_scan = time.time()

    def snapshot(self):
        with self.lock:
            out = dict(self.meta)
            for rel, ts in self.tombstones.items():
                out[rel] = {"kind": "file", "size": 0, "updatedAt": ts, "hash": None, "isDeleted": True}
            return out

    def mark_deleted(self, rel):
        with self.lock:
            self.tombstones[rel] = int(time.time() * 1000)
            self.meta.pop(rel, None)
            self.dirty = True
            self.rev += 1

    def touch(self):
        with self.lock:
            self.dirty = True


class Bridge:
    def __init__(self, exec_enabled=True):
        self.state = load_state()
        self.scanners = {}
        self.exec_enabled = exec_enabled
        # 変更検知。serve のときだけ入る（CLI では None のまま）。
        self.watcher = None
        for name, path in self.state["roots"].items():
            self.scanners[name] = RootScanner(name, path, self.ignore_for(name))

    # -- 無視パターン -----------------------------------------------------
    def ignore_for(self, name):
        """ルートで効く一覧。OS 側から受け取ったものがあればそれ、無ければ全体の既定。"""
        pats = self.state["rootIgnore"].get(name)
        return list(pats) if isinstance(pats, list) else list(self.state["ignorePatterns"])

    def ignore_source(self, name):
        return "client" if isinstance(self.state["rootIgnore"].get(name), list) else "server"

    def set_root_ignore(self, name, patterns):
        """OS 側が送ってきた一覧を保存して即座に効かせる。変わったときだけ True。"""
        patterns = [str(p) for p in patterns]
        with _state_lock:
            if name not in self.state["roots"]:
                raise KeyError(name)
            if self.state["rootIgnore"].get(name) == patterns:
                return False
            self.state["rootIgnore"][name] = patterns
            save_state(self.state)
            s = self.scanners.get(name)
            if s:
                s.set_ignore(patterns)
        return True

    # -- ルート管理 -------------------------------------------------------
    def add_root(self, path, name=None):
        p = Path(path).expanduser().resolve()
        if not p.is_dir():
            raise ValueError(f"ディレクトリが存在しません: {p}")
        name = name or p.name
        with _state_lock:
            existing = self.state["roots"].get(name)
            if existing and Path(existing).resolve() != p:
                raise ValueError(f"ルート名 '{name}' は別のパスに使われています: {existing}")
            self.state["roots"][name] = str(p)
            save_state(self.state)
            self.scanners[name] = RootScanner(name, p, self.ignore_for(name))
        # **起動後に増えたルートにも監視を張る。** これを忘れると、そのルートは
        # 60 秒ごとの保険走査でしか変更に気づかない（実測 42〜57 秒）。
        if self.watcher:
            self.watcher.watch(name)
        return name

    def remove_root(self, name):
        with _state_lock:
            if name not in self.state["roots"]:
                raise KeyError(name)
            del self.state["roots"][name]
            self.state["rootIgnore"].pop(name, None)
            save_state(self.state)
            self.scanners.pop(name, None)
        if self.watcher:
            self.watcher.unwatch(name)

    def scanner(self, name):
        s = self.scanners.get(name)
        if s is None:
            raise KeyError(name)
        return s

    def set_ignore(self, patterns):
        with _state_lock:
            self.state["ignorePatterns"] = list(patterns)
            save_state(self.state)
            for name, s in self.scanners.items():
                # OS 側から受け取った一覧を持つルートには全体の既定は効かない
                if self.ignore_source(name) == "server":
                    s.set_ignore(patterns)

    def rev_token(self):
        """いまの状態を表す短い文字列。ルートの増減と各ルートの rev を含む。

        約束するのは一点だけ:「中身が変わればこの文字列も変わる」。
        OS 側はこれを解釈せず、受け取った値をそのまま since に載せて返す。
        """
        with _state_lock:
            names = sorted(self.state["roots"].keys())
        parts = []
        for name in names:
            s = self.scanners.get(name)
            parts.append(f"{name}:{s.rev if s else 0}")
        return "|".join(parts)

    def describe(self):
        out = []
        for name, path in self.state["roots"].items():
            s = self.scanners.get(name)
            out.append({
                "name": name,
                "path": str(path),
                "files": len(s.meta) if s else 0,
                "lastScan": s.last_scan if s else 0,
                "rev": s.rev if s else 0,
                # 監視が張れているか。**黙って効いていない**のがいちばん困るので必ず出す。
                "watching": bool(self.watcher and self.watcher.is_watching(name)),
                "watchError": self.watcher.error_of(name) if self.watcher else "変更検知は未起動です",
                # いま効いている無視パターン。OS 側は自分の一覧と比べ、違えば送り直す。
                # 旧サーバーはこの鍵を持たないので、OS 側は「無ければ送らない」と判断できる。
                "ignorePatterns": list(s.ignore) if s else [],
                "ignoreSource": self.ignore_source(name),
            })
        return out


# --------------------------------------------------------------------------
# サーバー
# --------------------------------------------------------------------------

def build_app(bridge):
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, Response

    app = FastAPI(title="Itera Local Bridge", version=VERSION)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], expose_headers=["*"],
    )

    def get_scanner(root):
        try:
            return bridge.scanner(root)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"未登録のルート: {root}")

    def resolve(scanner, rel):
        target = (scanner.path / rel).resolve()
        if target != scanner.path and scanner.path not in target.parents:
            raise HTTPException(status_code=400, detail="ルート外のパスは操作できません")
        return target

    def status_payload():
        # 同一性を平坦に載せる。OS 側はこれを接続名の決定と、
        # アンカー照合（別の機械に繋ぎ替えられていないか）に使う。
        out = {
            "version": VERSION,
            "execEnabled": bridge.exec_enabled,
            "roots": bridge.describe(),
            "ignorePatterns": bridge.state["ignorePatterns"],
            # 変更検知の版。OS 側はこれをそのまま since に載せて返してくる。
            "revToken": bridge.rev_token(),
            # long-poll に対応していることの明示。旧サーバーはこの鍵を持たないので、
            # OS 側は「無ければ従来の間隔ポーリング」と判断できる。
            "longPoll": True,
        }
        out.update(host_identity())
        return out

    @app.get("/api/status")
    async def status(wait: float = 0.0, since: str = ""):
        """wait>0 かつ since が渡されたら、版が変わるまで応答を保留する（long-poll）。

        反映の遅れの支配項は OS 側の 5 秒ポーリングだった（実測）。
        「変わったら即返す」経路を足して、その待ちを 0 にする。
        待機は asyncio.sleep で行う。イベントループもワーカースレッドも塞がない。
        since が空・古い・壊れているときは待たずに即返す（誤って待たせない）。
        """
        if wait > 0 and since:
            deadline = time.monotonic() + min(wait, MAX_LONG_POLL_SEC)
            while bridge.rev_token() == since and time.monotonic() < deadline:
                await asyncio.sleep(LONG_POLL_STEP_SEC)
        return status_payload()

    @app.get("/api/roots")
    async def list_roots():
        return {"roots": bridge.describe()}

    @app.post("/api/roots")
    async def add_root(payload: dict):
        try:
            name = bridge.add_root(payload.get("path"), payload.get("name"))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        bridge.scanner(name).touch()
        return {"ok": True, "name": name}

    @app.delete("/api/roots/{name}")
    async def del_root(name: str):
        try:
            bridge.remove_root(name)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"未登録のルート: {name}")
        return {"ok": True}

    @app.get("/api/config")
    async def get_config():
        return {"ignorePatterns": bridge.state["ignorePatterns"]}

    @app.post("/api/config")
    async def set_config(payload: dict):
        pats = payload.get("ignorePatterns")
        if not isinstance(pats, list):
            raise HTTPException(status_code=400, detail="ignorePatterns は配列である必要があります")
        bridge.set_ignore(pats)
        return {"ok": True}

    @app.get("/api/{root}/meta")
    async def get_meta(root: str):
        return get_scanner(root).snapshot()

    @app.post("/api/{root}/ignore")
    def set_root_ignore(root: str, payload: dict):
        """OS 側の無視パターンを受け取り、このルートの列挙に効かせる（T-0164）。

        送られてくるのは OS 側で実際に効いている一覧（全体 ∪ 接続 ∪ ルートの和）。
        ここでは**それをそのまま**使う。サーバー側で足し引きすると両者の判定がずれ、
        「OS には来ないのに掃除の対象にも出ない」項目が生まれる。
        変わったときはその場で走査し直し、応答が返る時点で一覧に反映済みにする。
        """
        scanner = get_scanner(root)
        pats = payload.get("ignorePatterns")
        if not isinstance(pats, list) or not all(isinstance(p, str) for p in pats):
            raise HTTPException(status_code=400, detail="ignorePatterns は文字列の配列である必要があります")
        changed = bridge.set_root_ignore(root, pats)
        if changed:
            scanner.scan()
        return {
            "ok": True,
            "changed": changed,
            "count": len(scanner.ignore),
            "files": len(scanner.meta),
            "rev": scanner.rev,
        }

    # 以下、ブロックする処理を持つハンドラは async def にしない。
    # async def の中で同期 I/O を回すとイベントループが止まり、その間サーバーは
    # 一切の要求に応答できなくなる（bash_exec の中から attach を呼んで自滅した）。
    # 素の def にすると Starlette がワーカースレッドで実行してくれる。
    @app.get("/api/{root}/file/{rel:path}")
    def get_file(root: str, rel: str):
        scanner = get_scanner(root)
        target = resolve(scanner, rel)
        if not target.is_file():
            raise HTTPException(status_code=404, detail="ファイルがありません")
        return Response(content=target.read_bytes(), media_type="application/octet-stream")

    @app.put("/api/{root}/file/{rel:path}")
    async def put_file(root: str, rel: str, request: Request):
        scanner = get_scanner(root)
        target = resolve(scanner, rel)
        expected = request.headers.get("x-expected-hash")
        if expected and target.is_file():
            st = target.stat()
            current = scanner.file_hash(str(target), st)
            if current != expected:
                # 楽観的排他。取り違えたまま上書きするより失敗させる。
                raise HTTPException(status_code=409, detail="ホスト側が変更されています")
        body = await request.body()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        st = target.stat()
        digest = scanner.file_hash(str(target), st)
        scanner.touch()
        return {"hash": digest, "size": st.st_size, "updatedAt": int(st.st_mtime * 1000)}

    @app.delete("/api/{root}/file/{rel:path}")
    def delete_file(root: str, rel: str, request: Request):
        scanner = get_scanner(root)
        target = resolve(scanner, rel)
        expected = request.headers.get("x-expected-hash")
        if expected and target.is_file():
            current = scanner.file_hash(str(target), target.stat())
            if current != expected:
                raise HTTPException(status_code=409, detail="ホスト側が変更されています")
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
        else:
            raise HTTPException(status_code=404, detail="ファイルがありません")
        scanner.mark_deleted(rel)
        return {"ok": True}

    @app.post("/api/{root}/verify")
    def verify(root: str, payload: dict):
        """スタブ化の前提確認。実体があり、ハッシュが一致するときだけ ok を返す。

        「不在」と「判定不能」を混ぜないため、判定できない場合は 5xx を返して
        呼び出し側に中断させる（ここで False を返すと破壊が進む）。
        """
        scanner = get_scanner(root)
        results = {}
        for rel in payload.get("paths", []):
            target = resolve(scanner, rel)
            if not target.is_file():
                results[rel] = {"present": False}
                continue
            st = target.stat()
            results[rel] = {"present": True, "hash": scanner.file_hash(str(target), st), "size": st.st_size}
        return {"results": results}

    @app.post("/api/{root}/search")
    def search(root: str, payload: dict):
        scanner = get_scanner(root)
        query = payload.get("query") or ""
        if not query:
            raise HTTPException(status_code=400, detail="query は必須です")
        use_regex = bool(payload.get("regex"))
        limit = min(int(payload.get("limit") or 40), 500)
        include = payload.get("include") or ""
        matches = _run_search(scanner, query, use_regex, include, limit)
        return {"matches": matches, "count": len(matches), "engine": _search_engine()}

    @app.post("/api/exec")
    def api_exec(payload: dict):
        if not bridge.exec_enabled:
            raise HTTPException(status_code=403, detail="このサーバーは --exec off で起動しています")
        command = (payload.get("command") or "").strip()
        if not command:
            raise HTTPException(status_code=400, detail="command は必須です")
        timeout = min(int(payload.get("timeout") or 60), 600)
        scope = payload.get("scope") or "root"
        cwd_in = payload.get("cwd") or "."
        if scope == "host":
            cwd = Path(cwd_in).expanduser().resolve() if cwd_in != "." else Path.home()
        else:
            scanner = get_scanner(payload.get("root"))
            cwd = (scanner.path / cwd_in).resolve()
            if cwd != scanner.path and scanner.path not in cwd.parents:
                raise HTTPException(status_code=400, detail="cwd がルートの外を指しています")
        if not cwd.is_dir():
            raise HTTPException(status_code=400, detail=f"作業ディレクトリがありません: {cwd}")
        started = time.time()
        try:
            proc = subprocess.run(
                ["bash", "-lc", command], cwd=str(cwd),
                capture_output=True, text=True, timeout=timeout,
            )
            out, err, code = proc.stdout, proc.stderr, proc.returncode
        except subprocess.TimeoutExpired as e:
            out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
            err = (e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or "")) + f"\n[timeout {timeout}s]"
            code = 124
        for s in bridge.scanners.values():
            s.touch()
        return {
            "exitCode": code,
            "stdout": out,
            "stderr": err,
            "cwd": str(cwd),
            "durationMs": int((time.time() - started) * 1000),
        }

    # 変更通知に WebSocket は使わない。素の uvicorn では upgrade が失敗するうえ、
    # 送信側の実装も無かった。OS 側は /api/status の rev を見て変更に気づく。
    return app


def _search_engine():
    return "ripgrep" if shutil.which("rg") else "python"


def _run_search(scanner, query, use_regex, include, limit):
    matches = []
    rg = shutil.which("rg")
    if rg:
        cmd = [rg, "--line-number", "--no-heading", "--color", "never", "--max-count", "5"]
        if not use_regex:
            cmd.append("--fixed-strings")
        if include:
            for ext in [e.strip() for e in include.split(",") if e.strip()]:
                cmd += ["--glob", f"*{ext}"]
        for pat in scanner.ignore:
            pat = (pat or "").strip()
            if pat and not pat.startswith("#"):
                cmd += ["--glob", f"!{pat}"]
        cmd += [query, str(scanner.path)]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            for line in proc.stdout.splitlines():
                parts = line.split(":", 2)
                if len(parts) < 3:
                    continue
                rel = os.path.relpath(parts[0], scanner.path).replace(os.sep, "/")
                matches.append({"path": rel, "line": int(parts[1]), "text": parts[2][:300]})
                if len(matches) >= limit:
                    break
            return matches
        except Exception:
            pass  # ripgrep が失敗したら Python 実装へ落とす
    import re
    needle = re.compile(query) if use_regex else None
    exts = [e.strip() for e in include.split(",") if e.strip()] if include else []
    for rel, info in sorted(scanner.snapshot().items()):
        if info.get("kind") != "file" or info.get("isDeleted"):
            continue
        if exts and not any(rel.endswith(e) for e in exts):
            continue
        target = scanner.path / rel
        try:
            with open(target, "r", encoding="utf-8", errors="ignore") as f:
                for i, line in enumerate(f, 1):
                    hit = needle.search(line) if needle else (query in line)
                    if hit:
                        matches.append({"path": rel, "line": i, "text": line.rstrip()[:300]})
                        if len(matches) >= limit:
                            return matches
        except (OSError, UnicodeDecodeError):
            continue
    return matches


class RootWatcher:
    """ホスト側の変更検知。

    **ルートは起動後にも増える。** v3.3.0 までは起動時に存在したルートにしか監視を
    張っておらず、`attach` で足したルートは 60 秒ごとの保険走査でしか気づかなかった。
    しかも遅いだけで動いてはいるので、壊れていることに気づけない
    （実測: 書き込みから rev 更新まで 42〜57 秒）。

    そこで (1) ルートの増減に追従し、(2) **監視が張れているかを外から見えるようにする**。
    watchdog が無い環境や inotify の上限に当たった環境でも、定期走査で動き続ける。
    """

    def __init__(self, bridge):
        self.bridge = bridge
        self.observer = None
        self.watches = {}
        self.errors = {}
        self.error = None
        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler
        except ImportError:
            self.error = "watchdog が入っていないため、変更検知は定期走査だけになります"
            return

        class Handler(FileSystemEventHandler):
            def __init__(self, scanner):
                self.scanner = scanner

            def on_any_event(self, event):
                self.scanner.touch()

        self._handler_cls = Handler
        self.observer = Observer()
        self.observer.daemon = True
        self.observer.start()

    def watch(self, name):
        """ルート1つに監視を張る。二重には張らない。"""
        if not self.observer or name in self.watches:
            return
        scanner = self.bridge.scanners.get(name)
        if scanner is None or not scanner.path.is_dir():
            return
        try:
            self.watches[name] = self.observer.schedule(
                self._handler_cls(scanner), str(scanner.path), recursive=True
            )
            self.errors.pop(name, None)
        except OSError as e:
            # inotify の上限などで張れないことがある。**握りつぶさず理由を残す**
            # （定期走査があるので同期そのものは続く）。
            self.errors[name] = f"監視を張れませんでした: {e}"

    def unwatch(self, name):
        w = self.watches.pop(name, None)
        self.errors.pop(name, None)
        if w and self.observer:
            try:
                self.observer.unschedule(w)
            except Exception:
                pass

    def watch_all(self):
        for name in list(self.bridge.scanners.keys()):
            self.watch(name)

    def is_watching(self, name):
        return name in self.watches

    def error_of(self, name):
        return self.errors.get(name) or self.error


def start_watchers(bridge):
    """変更検知を起動し、いまあるルートすべてに監視を張る。"""
    watcher = RootWatcher(bridge)
    bridge.watcher = watcher
    watcher.watch_all()
    return watcher


def scan_loop(bridge, quiet_sec=1.5, safety_sec=60.0):
    """デバウンス付きの再走査ループ。イベント1件ごとの即時フルスキャンはしない
    （v2.0 はそれで 13GB のツリー移動時に事実上ハングした）。"""
    last_touch = {}
    while True:
        now = time.time()
        for name, scanner in list(bridge.scanners.items()):
            if scanner.dirty:
                last_touch.setdefault(name, now)
                if now - last_touch[name] >= quiet_sec:
                    scanner.scan()
                    last_touch.pop(name, None)
            elif now - scanner.last_scan >= safety_sec:
                scanner.scan()
        time.sleep(0.5)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def cli_request(port, method, path, payload=None):
    import urllib.error
    import urllib.request
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode() or "{}")
    except urllib.error.URLError as e:
        raise SystemExit(f"[itera] サーバーに接続できません ({url}): {e}")


def main():
    parser = argparse.ArgumentParser(description="Itera OS Local Bridge")
    sub = parser.add_subparsers(dest="cmd")

    p_serve = sub.add_parser("serve", help="サーバーを起動する")
    p_serve.add_argument("--port", type=int, default=8001)
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--dir", action="append", default=[], help="起動時に追加するルート（複数可）")
    p_serve.add_argument("--exec", dest="exec_mode", choices=["on", "off"], default="on")

    p_attach = sub.add_parser("attach", help="ルートを追加する")
    p_attach.add_argument("dir", nargs="?", default=".")
    p_attach.add_argument("--name")
    p_attach.add_argument("--port", type=int, default=8001)

    p_detach = sub.add_parser("detach", help="ルートを取り外す")
    p_detach.add_argument("name")
    p_detach.add_argument("--port", type=int, default=8001)

    p_ls = sub.add_parser("ls", help="ルート一覧")
    p_ls.add_argument("--port", type=int, default=8001)

    args = parser.parse_args()

    if args.cmd in (None, "serve"):
        port = getattr(args, "port", 8001)
        host = getattr(args, "host", "127.0.0.1")
        bridge = Bridge(exec_enabled=getattr(args, "exec_mode", "on") == "on")
        for d in getattr(args, "dir", []):
            name = bridge.add_root(d)
            print(f"[itera] ルート追加: {name} -> {Path(d).expanduser().resolve()}")
        for s in bridge.scanners.values():
            s.scan()
        start_watchers(bridge)
        threading.Thread(target=scan_loop, args=(bridge,), daemon=True).start()
        import uvicorn
        ident = host_identity()
        print(f"[itera] Local Bridge v{VERSION} — http://{host}:{port}")
        print(f"[itera] 名乗り: {ident['hostname']} ({ident['user']}@{ident['platform']})")
        print(f"[itera] machineId: {ident['machineId']}")
        print(f"[itera] ルート: {[r['name'] for r in bridge.describe()] or '（なし。itera attach で追加）'}")
        for r in bridge.describe():
            state = "監視あり" if r["watching"] else f"監視なし（{r['watchError'] or '理由不明'}）"
            print(f"[itera]   {r['name']}: {state}")
        print(f"[itera] シェル実行: {'有効' if bridge.exec_enabled else '無効 (--exec off)'}")
        uvicorn.run(build_app(bridge), host=host, port=port, log_level="warning")
        return

    if args.cmd == "attach":
        path = str(Path(args.dir).expanduser().resolve())
        res = cli_request(args.port, "POST", "/api/roots", {"path": path, "name": args.name})
        print(f"[itera] 追加しました: {res.get('name')} -> {path}")
        return

    if args.cmd == "detach":
        cli_request(args.port, "DELETE", f"/api/roots/{args.name}")
        print(f"[itera] 取り外しました: {args.name}")
        return

    if args.cmd == "ls":
        res = cli_request(args.port, "GET", "/api/roots")
        for r in res.get("roots", []):
            print(f"  {r['name']:<20} {r['files']:>7} files  {r['path']}")
        return


if __name__ == "__main__":
    main()