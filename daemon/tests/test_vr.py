"""VR 通道：订快照、发动作、交棒。

两层各测各的：
* `VrSession` 对**真的** zenoh 端点（一个假桥 peer）—— 那条路是新的依赖，必须真跑；
* server 那层用替身，只钉住**帧的形状与判据**（`vr_conn` 进握手、`ok` 取自桥的回执）。
"""

from __future__ import annotations

import json
import socket
import time
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from litearm_studio_daemon import server
from litearm_studio_daemon.errors import VrBridgeUnreachableError
from litearm_studio_daemon.server import create_app
from litearm_studio_daemon.session import Session
from litearm_studio_daemon.vr import VrSession

# ── 工具 ────────────────────────────────────────────────────────────────────


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_until(predicate, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class FakeBridge:
    """假桥：一条 zenoh **peer**，两条臂的快照口 + 一个动作应答口。

    与现场同形（桥就是 peer，本会话是 client 连它的监听端点），只是把内容换成
    测试想推什么就推什么。
    """

    def __init__(self) -> None:
        import zenoh

        self.port = free_port()
        config = zenoh.Config()
        config.insert_json5("mode", '"peer"')
        config.insert_json5("listen/endpoints",
                            json.dumps([f"tcp/127.0.0.1:{self.port}"]))
        config.insert_json5("scouting/multicast/enabled", "false")
        config.insert_json5("scouting/gossip/enabled", "false")
        self.session = zenoh.open(config)
        #: 收动作的应答内容（默认照桥的成功回执形状）
        self.reply: dict = {"ok": True, "code": "estop_sent", "result": {}}
        self.actions: list[dict] = []
        self.session.declare_queryable("litearm/v4/armA/vr_rpc", self._on_query)
        self.pubs = {
            arm: self.session.declare_publisher(f"litearm/v4/{arm}/vr_status")
            for arm in ("armA", "armB")
        }

    @property
    def endpoint(self) -> str:
        return f"tcp/127.0.0.1:{self.port}"

    def _on_query(self, query: Any) -> None:
        self.actions.append(json.loads(bytes(query.payload)))
        query.reply(query.key_expr, json.dumps(self.reply).encode("utf-8"))

    def push(self, arm: str, snapshot: dict) -> None:
        self.pubs[arm].put(json.dumps(snapshot).encode("utf-8"))

    def close(self) -> None:
        self.session.close()


@pytest.fixture()
def bridge():
    fake = FakeBridge()
    yield fake
    fake.close()


# ── VrSession：对真的 zenoh 端点 ────────────────────────────────────────────


def test_two_arms_arrive_on_one_wildcard_subscription(bridge: FakeBridge) -> None:
    """一条订阅吃下两条臂的流，各份快照按自带 `arm_id` 分流。"""
    vr = VrSession(endpoint=bridge.endpoint)
    frames: list[dict] = []
    vr.add_listener(frames.append)
    vr.start()
    try:
        # 会话开起来是 waiting（连上了没人推快照）；"在线"要等第一份快照到
        assert wait_until(lambda: vr.status == "waiting"), vr.conn_info()
        bridge.push("armA", {"arm_id": "armA", "arm": {"q": [0.0] * 7}})
        bridge.push("armB", {"arm_id": "armB", "arm": {"q": [1.0] * 7}})
        assert wait_until(lambda: vr.status == "connected"), vr.conn_info()
        assert wait_until(lambda: sorted(vr.snapshots()) == ["armA", "armB"])
        # 快照原样保存：前端那套映射认的就是桥的形状，这里一个字都不改
        assert vr.state("armB") == {"arm_id": "armB", "arm": {"q": [1.0] * 7}}
        assert wait_until(lambda: any(
            f.get("t") == "vr_state" and f.get("arm") == "armB" for f in frames))
        states = [f for f in frames if f.get("t") == "vr_state"]
        assert states[0]["state"]["arm_id"] in ("armA", "armB")
        assert vr.conn_info()["arms"] == ["armA", "armB"]
    finally:
        vr.close()


def test_action_goes_out_as_a_query_and_returns_the_bridge_receipt(
        bridge: FakeBridge) -> None:
    bridge.reply = {"ok": False, "code": "estop_sent_failed",
                    "error": {"type": "UpstreamRefused", "message": "跟随服务不可达或拒绝"}}
    vr = VrSession(endpoint=bridge.endpoint)
    vr.start()
    try:
        assert wait_until(lambda: vr.status == "waiting"), vr.conn_info()
        bridge.push("armA", {"arm_id": "armA"})   # 有快照才知道动作发给谁
        assert wait_until(lambda: vr.status == "connected"), vr.conn_info()
        receipt = vr.execute("vr.estop")
        # 桥说没停成，这边就照原样回 "没停成" —— 不替它翻译成"发送成功"
        assert receipt["ok"] is False
        assert receipt["error"]["message"] == "跟随服务不可达或拒绝"
        assert bridge.actions == [{"action": "estop"}]
    finally:
        vr.close()


def test_bridge_offline_is_reported_and_actions_refuse() -> None:
    """桥不在：状态如实报 error（几秒内，不干等），动作直接拒。"""
    vr = VrSession(endpoint=f"tcp/127.0.0.1:{free_port()}")
    vr.start()
    try:
        assert wait_until(lambda: vr.status == "error"), vr.conn_info()
        assert vr.conn_info()["error"]
        with pytest.raises(VrBridgeUnreachableError):
            vr.execute("vr.estop")
    finally:
        started = time.monotonic()
        vr.close()
        # 收尾不能挂：`zenoh.open` 那次连接必须有超时（见 session 模块的常量注释）
        assert time.monotonic() - started < 3.0


def test_unknown_vr_command_is_rejected() -> None:
    vr = VrSession(endpoint="tcp/127.0.0.1:1")
    with pytest.raises(Exception) as exc:
        vr.execute("vr.teleport")
    assert "vr.teleport" in str(exc.value)


# ── 交棒：等"已失能"确认 ───────────────────────────────────────────────────


class _StubArmSession:
    def __init__(self, doc: Optional[dict]) -> None:
        self._doc = doc

    def state(self) -> Optional[dict]:
        return self._doc


def test_wait_arm_disabled_reads_the_state_frame() -> None:
    assert server._wait_arm_disabled(_StubArmSession({"enabled": False}), 0.2) is True
    assert server._wait_arm_disabled(_StubArmSession({"enabled": True}), 0.2) is False
    # 读不到状态帧就不拦 —— 门禁的权威在固件，本地这一眼只为可读性
    assert server._wait_arm_disabled(_StubArmSession(None), 0.2) is True


# ── server 那层：帧的形状与判据 ─────────────────────────────────────────────


class StubVr:
    """替身：只记调用、只回预设载荷（真 zenoh 那条路在上面的用例里测）。"""

    def __init__(self, *, receipt: Any = None, error: Optional[Exception] = None) -> None:
        self.receipt = {"ok": True, "code": "estop_sent", "result": {}} if receipt is None else receipt
        self.error = error
        self.calls: list[tuple[str, dict]] = []
        self.listeners: list[Any] = []

    def add_listener(self, cb: Any) -> None:
        self.listeners.append(cb)

    def conn_info(self) -> dict:
        return {"status": "waiting", "endpoint": "tcp/127.0.0.1:7447",
                "arms": [], "lastStateAgeMs": None, "error": None}

    def snapshots(self) -> dict:
        return {}

    def execute(self, method: str, params: Optional[dict] = None) -> Any:
        self.calls.append((method, params or {}))
        if self.error is not None:
            raise self.error
        return self.receipt


def make_app(vr: Any = None):
    session = Session(port_finder=lambda: None)
    return create_app(session, vr=vr), session


def drain_handshake(ws: Any, *, expect: int = 2) -> list[dict]:
    """读掉握手帧，返回 `hello` 之后的 `expect` 条（默认 conn + log_meta）。"""
    hello = ws.receive_json()
    assert hello["t"] == "hello"
    return [ws.receive_json() for _ in range(expect)]


def await_res(ws: Any, limit: int = 30) -> dict:
    for _ in range(limit):
        frame = ws.receive_json()
        if frame.get("t") == "res":
            return frame
    raise AssertionError(f"没有等到 res 帧（已读 {limit} 条）")


def test_handshake_carries_vr_conn() -> None:
    vr = StubVr()
    app, _ = make_app(vr)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            frames = drain_handshake(ws, expect=3)
    assert [f["t"] for f in frames] == ["conn", "log_meta", "vr_conn"]
    assert frames[2]["status"] == "waiting"


def test_vr_action_returns_the_bridge_receipt() -> None:
    vr = StubVr(receipt={"ok": True, "code": "teleop_started", "result": {}})
    app, _ = make_app(vr)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            drain_handshake(ws)
            ws.send_json({"t": "cmd", "id": 7, "m": "vr.teleop_start", "p": {}})
            res = await_res(ws)
    assert res["ok"] is True
    assert res["v"]["receipt"] == vr.receipt
    assert vr.calls == [("vr.teleop_start", {})]


def test_teleop_start_hands_the_arm_over() -> None:
    """`vr.teleop_start` 会先把臂交出去；没连臂时如实回"未连接"，不拦后续动作。"""
    vr = StubVr()
    app, _ = make_app(vr)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            drain_handshake(ws)
            ws.send_json({"t": "cmd", "id": 8, "m": "vr.teleop_start", "p": {}})
            res = await_res(ws)
    assert res["v"]["handover"] == {"released": False, "reason": "未连接"}


def test_bridge_refusal_comes_back_as_a_failed_res() -> None:
    """桥听见了但拒绝：`ok` 必须跟着桥走 —— 急停没停成不能显示成成功。"""
    vr = StubVr(receipt={"ok": False, "code": "estop_sent_failed",
                         "error": {"type": "UpstreamRefused",
                                   "message": "跟随服务不可达或拒绝"}})
    app, _ = make_app(vr)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            drain_handshake(ws)
            ws.send_json({"t": "cmd", "id": 9, "m": "vr.estop", "p": {}})
            res = await_res(ws)
    assert res["ok"] is False
    assert res["err"]["msg"] == "跟随服务不可达或拒绝"
    assert res["err"]["receipt"]["code"] == "estop_sent_failed"


def test_unreachable_bridge_is_reported_as_such() -> None:
    vr = StubVr(error=VrBridgeUnreachableError("tcp/127.0.0.1:7447", "estop", "没有回执"))
    app, _ = make_app(vr)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            drain_handshake(ws)
            ws.send_json({"t": "cmd", "id": 10, "m": "vr.estop", "p": {}})
            res = await_res(ws)
    assert res["ok"] is False
    assert "没有回执" in json.dumps(res["err"], ensure_ascii=False)


def test_no_vr_channel_answers_with_a_named_error() -> None:
    app, _ = make_app(None)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            frames = drain_handshake(ws)
            ws.send_json({"t": "cmd", "id": 11, "m": "vr.estop", "p": {}})
            res = await_res(ws)
    assert [f["t"] for f in frames] == ["conn", "log_meta"]  # 没有 vr_conn
    assert res["ok"] is False
    assert res["err"]["kind"] == "VrNotAvailableError"
