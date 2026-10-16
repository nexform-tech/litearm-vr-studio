"""VR 通道：订快照、发动作、交棒。

两层各测各的：
* `VrSession` 对**真的** zenoh 端点（一个假桥 peer）—— 那条路是新的依赖，必须真跑；
* server 那层用替身，只钉住**帧的形状与判据**（`vr_conn` 进握手、`ok` 取自桥的回执）。
"""

from __future__ import annotations

import asyncio
import json
import socket
import time
from pathlib import Path
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

    def put(self, key: str, payload: dict) -> None:
        """往任意话题发一份（真机状态那两条用得上）。"""
        self.session.put(key, json.dumps(payload).encode("utf-8"))

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


def test_arm_manifest_actions_pass_params_through(bridge: FakeBridge) -> None:
    """臂清单两条命令：名字映射到桥的动作名，参数**原样**进请求体。

    判据（同名口、正在跑、自定义命令）全在桥那边一处 —— 这边不替它解释、也不预判，
    否则两边各有一套规则，迟早出现"界面放行、桥拒绝"的怪状。
    """
    bridge.reply = {"ok": True, "code": "arms_set", "result": {"applied": ["armA"]}}
    vr = VrSession(endpoint=bridge.endpoint)
    vr.start()
    try:
        assert wait_until(lambda: vr.status == "waiting"), vr.conn_info()
        bridge.push("armA", {"arm_id": "armA"})   # 有快照才知道动作发给谁
        assert wait_until(lambda: vr.status == "connected"), vr.conn_info()
        vr.execute("vr.list_ports")
        receipt = vr.execute("vr.set_arm_devices",
                             {"devices": {"armA": "/dev/serial/by-id/usb-A2"}})
        assert receipt["code"] == "arms_set"
        assert bridge.actions == [
            {"action": "ports.list"},
            {"action": "arms.set", "devices": {"armA": "/dev/serial/by-id/usb-A2"}},
        ]
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

    #: 与真 `VrSession` 同名的连接态 —— `Daemon._vr_holds_arm` 会看它一眼：
    #: 桥不可达（快照过期）时只信本进程记的那份动作，免得一条陈旧快照把「连接」锁死。
    status = "waiting"

    def __init__(self, *, receipt: Any = None, error: Optional[Exception] = None) -> None:
        self.receipt = {"ok": True, "code": "estop_sent", "result": {}} if receipt is None else receipt
        self.error = error
        self.calls: list[tuple[str, dict]] = []
        self.listeners: list[Any] = []
        self.snapshot_map: dict = {}

    def add_listener(self, cb: Any) -> None:
        self.listeners.append(cb)

    def conn_info(self) -> dict:
        return {"status": self.status, "endpoint": "tcp/127.0.0.1:7447",
                "arms": [], "lastStateAgeMs": None, "error": None}

    def snapshots(self) -> dict:
        return dict(self.snapshot_map)

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


def test_vr_conn_is_replayed_for_a_late_listener() -> None:
    """`vr_conn` 只在"接入"与"状态变化"时报一条是**不够的**，所以它要定期重播。

    漏掉它的是最正常的那种情形 —— 桥一直连着、状态从头到尾没变过。页面那侧的 VR 模块
    是按路由懒加载的（`main.tsx` 的 `React.lazy`），它挂上监听时握手早过去了：
    本地实测 socket 在 532ms 收到 `vr_conn`、VR 那块 665ms 才注册监听。表现出来就是
    "桥明明连着，链路卡说未连接、臂映射卡永远灰着"—— 而这两处正决定操作员能不能开始遥操。

    这里直接驱动那个循环（不跑整个 app）：钉的是"没变化也要重播"，以及"没人看时不播"。
    """
    daemon = server.Daemon(Session(port_finder=lambda: None), vr=StubVr())
    seen: list[dict] = []
    daemon.broadcast = seen.append            # type: ignore[method-assign]

    async def run() -> None:
        task = asyncio.create_task(daemon._vr_conn_loop(interval=0.01))
        await asyncio.sleep(0.05)
        task.cancel()

    # 没有客户端时不播：对着空房间推状态只是白烧 CPU
    asyncio.run(run())
    assert seen == []

    daemon.clients = [object()]
    asyncio.run(run())
    assert seen and seen[0]["t"] == "vr_conn"
    assert seen[0]["status"] == "waiting"


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


def test_set_arm_devices_reaches_the_channel_with_its_params() -> None:
    """服务层只是**转达**：`p` 里的 devices 一个字不改地到通道上。

    桥拒绝时（`ok: false`）也如实回一条 `ok:false` 的 `res` —— 界面据此显示原因
    （同一个口给了两条臂、跟随服务还在跑、命令是自定义的…）。
    """
    vr = StubVr(receipt={"ok": False, "code": "Busy",
                         "error": {"type": "Busy", "message": "teleop 正在运行"}})
    app, _ = make_app(vr)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            drain_handshake(ws)
            ws.send_json({"t": "cmd", "id": 9, "m": "vr.set_arm_devices",
                          "p": {"devices": {"armA": "/dev/serial/by-id/usb-A2"}}})
            res = await_res(ws)
    assert res["ok"] is False
    assert vr.calls == [("vr.set_arm_devices",
                         {"devices": {"armA": "/dev/serial/by-id/usb-A2"}})]


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


def test_connect_is_refused_while_vr_holds_the_arm() -> None:
    """遥操正在跑时那条自动 `connect` 必须被**响亮拒绝**。

    现场剧本：VR 页开着遥操，studio 页面刷新（或 daemon 的 WS 重连）→ 前端自动补发
    `connect`（`main.tsx` 一进页面就发，`client.ts` 的 `_wantSession` 又会在 WS 重开时
    再发一次）→ 串口是独占的，这一连就从 follow 手里把口抢走 → 遥操断在半路，
    界面上只看到一句 `connection refused`。前端没有"让出"这个动作可点，所以这道闸门
    只能落在守着串口这一侧的 daemon 上。
    """
    vr = StubVr()
    vr.status = "connected"
    vr.snapshot_map = {"armA": {"link": {"forward_enabled": True}}}
    app, session = make_app(vr)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            drain_handshake(ws)
            ws.send_json({"t": "connect", "id": 5})
            res = await_res(ws)
    assert res["ok"] is False, res
    assert res["err"]["kind"] == "ArmHeldByVrError", res
    assert "先在 VR 页上停止遥操" in res["err"]["msg"], res
    assert session.connected is False, "被拒的 connect 不该偷偷真去连"


def test_connect_is_allowed_once_vr_lets_go() -> None:
    """闸门只拦"VR 正握着"这一种：快照说转发关了，`connect` 照旧放行。

    ⚠ 反面同样要钉：桥**不可达**时（快照过期、`status != connected`）不能拿最后一条
    陈旧快照继续拦 —— 那会把操作员永久锁在"连不上"里，而那时 VR 其实已经不在了。
    """
    vr = StubVr()
    vr.status = "waiting"                                   # 桥不可达：快照不作数
    vr.snapshot_map = {"armA": {"link": {"forward_enabled": True}}}
    app, session = make_app(vr)
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                drain_handshake(ws)
                ws.send_json({"t": "connect", "id": 6})
                res = await_res(ws)
        assert res.get("err", {}).get("kind") != "ArmHeldByVrError", res
    finally:
        session.close()


def test_the_gate_follows_this_process_own_actions() -> None:
    """闸门的第二个信号：**本进程刚下达的那个动作**。

    它盖住的是桥快照还没推到的几百毫秒 —— 而"点完开始遥操、页面正好在这时候重发
    connect"正是现场最容易撞上的那一拍。

    两条边界一并钉住：
    * 开始遥操**失败**（桥没接受）⇒ 不算握着口，别把「连接」锁死；
    * 停止/急停**失败**也解闸 —— follow 要么真停了、要么本来就没了，而"按钮点了没用"
      是最坏的那种失败。
    """
    vr = StubVr()
    vr.status = "connected"                     # 快照一条都没有：只看本进程的动作
    app, _ = make_app(vr)
    daemon = app.state.daemon
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            drain_handshake(ws)

            vr.receipt = {"ok": False, "code": "teleop_start_failed",
                          "error": {"type": "UpstreamRefused", "message": "跟随服务不可达"}}
            ws.send_json({"t": "cmd", "id": 7, "m": "vr.teleop_start", "p": {}})
            await_res(ws)
            assert daemon._vr_holds_arm() is False, "一次失败的开始遥操不该把闸门锁死"

            vr.receipt = {"ok": True, "code": "teleop_started", "result": {}}
            ws.send_json({"t": "cmd", "id": 8, "m": "vr.teleop_start", "p": {}})
            await_res(ws)
            assert daemon._vr_holds_arm() is True, "开始遥操成功了，串口该留给 VR"

            vr.receipt = {"ok": False, "code": "estop_sent_failed",
                          "error": {"type": "UpstreamRefused", "message": "跟随服务不可达"}}
            ws.send_json({"t": "cmd", "id": 9, "m": "vr.estop", "p": {}})
            await_res(ws)
            assert daemon._vr_holds_arm() is False, "停止失败也不许把闸门焊死"


def test_handover_waits_until_the_port_is_actually_closed() -> None:
    """交棒返回时，串口必须**已经**关干净 —— 不是"已经丢给执行器去关"。

    `Session.disconnect()` 把 `arm.close()` 丢进执行器就返回，而独占锁要等 fd 真的
    关掉才松开。不等这一下，紧随其后的 follow 会撞在"页面显示已交棒、口却还锁着"的
    窗口上（现场症状就是遥操起不来）。
    """
    session = Session(fake=True, reconnect=False,
                      poll_period=0.05, state_push_interval=0.05)
    app = create_app(session, vr=StubVr(), repo_dist=Path("/nonexistent-ui"))
    try:
        assert session.connect() is True
        deadline = time.monotonic() + 5.0
        while not session.connected and time.monotonic() < deadline:
            time.sleep(0.01)
        assert session.connected, f"假会话没连上: {session.arm_info()}"

        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                drain_handshake(ws)
                ws.send_json({"t": "cmd", "id": 12, "m": "vr.teleop_start", "p": {}})
                res = await_res(ws)

        assert res["v"]["handover"]["released"] is True, res
        assert session.connected is False, "交棒之后本进程不该还握着臂"
        # 超时给 0：能立刻回 True ⇒ 那次 close 在**交棒返回之前**就做完了。
        assert session.wait_link_closed(0.0) is True, "交棒返回时串口还没关干净"
    finally:
        session.close()


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
