"""`--fake` 的 VR 假件：帧的形状、臂映射的来回、以及它怎么接进 server。

与 `test_vr.py` 分开是有意的：那边测的是**真的** zenoh 那条路（一个假桥 peer），
这边测的是「没有桥、没有头显、没有真机时页面还能不能走通」。两者要钉的东西不一样，
而假件是纯 Python —— 装没装 zenoh 都该跑得起来，混在一起会让"没装 zenoh 的机器"
连这一组也一起跳过。
"""

from __future__ import annotations

import sys
import time
from argparse import Namespace
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from litearm_studio_daemon import __main__ as daemon_main
from litearm_studio_daemon.errors import UnknownCommandError
from litearm_studio_daemon.server import create_app
from litearm_studio_daemon.session import Session
from litearm_studio_daemon.vr import FakeVrSession
from litearm_studio_daemon.vr.fake import FAKE_DEVICES, FAKE_PORTS

#: 假件推一拍要多久（`TICK_S` 是 0.1s）—— 等帧时给足余量，别让 CI 的慢机器把用例弄红。
TICK_WAIT_S = 2.0

#: 用例里"改成另一个口"用的那个口。**不在候选列表里**是有意的：改映射这条路本来就
#: 允许手填（桥列不出口时界面就是手填框），而候选里只有四个口，改来改去会撞上重复口 ——
#: 那是另一条用例在钉的事。现场多一个 CDC 设备（调试探针、另一条臂的板子）很常见。
SPARE_PORT = "/dev/ttyACM2"


def wait_until(predicate, timeout: float = TICK_WAIT_S) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture()
def fake() -> Any:
    session = FakeVrSession()
    session.start()
    yield session
    session.close()


# ── 帧：页面读的那些字段都在 ────────────────────────────────────────────────


def test_two_arms_come_up_with_their_ports(fake: FakeVrSession) -> None:
    """快照是**每条臂一份**，`arm` 那段给的是身份与去处（映射卡读的就是这三样）。"""
    assert wait_until(lambda: sorted(fake.snapshots()) == ["armA", "armB"])
    conn = fake.conn_info()
    assert conn["status"] == "connected"
    assert conn["arms"] == ["armA", "armB"]
    assert conn["error"] is None

    left = fake.state("armA")["arm"]
    right = fake.state("armB")["arm"]
    assert (left["side"], right["side"]) == ("left", "right")
    assert left["device"] == FAKE_DEVICES["armA"]
    assert right["device"] == FAKE_DEVICES["armB"]
    # 一个口是谁定的：一条是装机默认、一条是操作员确认过的 —— 界面上这两行
    # **不该长得一样**，所以开局就把两种都给出来
    assert {left["device_source"], right["device_source"]} == {"config", "record"}


def test_frames_carry_both_halves_of_the_story(fake: FakeVrSession) -> None:
    """四种帧都要推：`vr_state` 来自桥那份、`vr_arm` / `vr_grip` 来自上游汇总那份。

    真链路上这是两台东西，假件一个人演 —— 对页面来说它们只是四种帧。
    """
    frames: list[dict] = []
    fake.add_listener(frames.append)
    assert wait_until(lambda: {"vr_state", "vr_arm", "vr_grip"} <= {f["t"] for f in frames})
    per_arm = [f for f in frames if f["t"] == "vr_state"]
    assert {f["arm"] for f in per_arm} == {"armA", "armB"}

    state = next(f for f in frames if f["t"] == "vr_arm" and f["arm"] == "armA")
    # 真机那条路报的口是**单独一份**（映射卡拿它跟桥认的口对拍）
    assert "device" in state["state"]
    assert isinstance(state["state"]["q"], list) and len(state["state"]["q"]) == 7


def test_each_arm_gets_its_own_gripper_readout(fake: FakeVrSession) -> None:
    """两条臂 ⇒ 可能两个夹爪，各占一个 CAN 口。

    真机状态按臂发，夹爪也一样 —— 挤成一份的话，双臂部署下页面会把两个夹爪的读数
    看成一个，而"这一下夹的是哪只手"正是操作员要判断的事。
    """
    left = fake.grip_state("armA")
    right = fake.grip_state("armB")
    assert left["device"] == "can0" and right["device"] == "can1"
    assert left["device"] != right["device"]
    # 形状照上游的 `GripperStatus`：负载卡读的是 `connected` 与 `tau`
    assert {"device", "connected", "ok", "q", "tau", "error"} <= set(left)


# ── 臂映射：看得见、改得动、记得住 ──────────────────────────────────────────


def test_ports_list_offers_the_arms_and_the_grippers(fake: FakeVrSession) -> None:
    """候选口由**桥那台机器**给（这里由假件扮）：两条臂两个串口 + 两个夹爪两个 CAN 口。

    路径与顺序都钉住 —— 这张卡的候选项就是操作员唯一能选的东西，多一个少一个都是
    "界面上看着有、现场其实没有"。
    """
    receipt = fake.execute("vr.list_ports")
    assert receipt["ok"] is True
    assert receipt["code"] == "ports_listed"
    ports = receipt["result"]["ports"]
    assert {p["kind"] for p in ports} == {"serial", "can"}
    assert [p["path"] for p in ports] == [p["path"] for p in FAKE_PORTS]
    assert [p["path"] for p in ports] == ["/dev/ttyACM0", "/dev/ttyACM1", "can0", "can1"]


def test_changing_one_port_applies_only_that_arm(fake: FakeVrSession) -> None:
    """改一条 → 只该那一条变成「已确认」，另一条一个字节都不动。

    顺手给没动的臂也写一条记录，等于替操作员对着实物又签了一次字。
    """
    before = fake.state("armA")["arm"]["device"]
    receipt = fake.execute("vr.set_arm_devices", {"devices": {"armB": SPARE_PORT}})
    assert receipt["ok"] is True and receipt["code"] == "arms_set"
    assert receipt["result"]["applied"] == ["armB"]

    assert fake.state("armB")["arm"]["device"] == SPARE_PORT
    assert fake.state("armB")["arm"]["device_source"] == "record"
    assert fake.state("armB")["arm"]["device_confirmed_at"]
    assert fake.state("armA")["arm"]["device"] == before
    assert fake.state("armA")["arm"]["device_source"] == "config"


def test_no_change_does_not_rewrite_the_record(fake: FakeVrSession) -> None:
    """原样保存 → `applied` 是空的，来源也不该从 config 变成 record。"""
    receipt = fake.execute("vr.set_arm_devices",
                           {"devices": {"armA": fake.state("armA")["arm"]["device"]}})
    assert receipt["ok"] is True
    assert receipt["result"]["applied"] == []
    assert receipt["result"]["note"]
    assert fake.state("armA")["arm"]["device_source"] == "config"


def test_duplicate_port_is_refused_in_the_bridges_own_words(fake: FakeVrSession) -> None:
    """同一个口指给两条臂：**必须拒**。这是"两条 follow 抢一个串口、谁也不报错"的入口。

    话术照桥抄 —— 卡片原样显示这句，翻成"保存失败"就什么都没说。
    """
    receipt = fake.execute("vr.set_arm_devices",
                           {"devices": {"armB": FAKE_DEVICES["armA"]}})
    assert receipt["ok"] is False
    assert receipt["code"] == "BadRequest"
    assert "同一个口被指给了两条臂" in receipt["error"]["message"]
    # 拒了就是没改：armB 还是原来那个口
    assert fake.state("armB")["arm"]["device"] == FAKE_DEVICES["armB"]


def test_bad_requests_are_refused(fake: FakeVrSession) -> None:
    assert fake.execute("vr.set_arm_devices", {}).get("ok") is False
    unknown = fake.execute("vr.set_arm_devices", {"devices": {"armZ": "/dev/ttyACM0"}})
    assert unknown["ok"] is False and "armZ" in unknown["error"]["message"]
    empty = fake.execute("vr.set_arm_devices", {"devices": {"armA": "  "}})
    assert empty["ok"] is False


def test_mapping_is_locked_while_teleop_runs(fake: FakeVrSession) -> None:
    """正在遥操时改不了：命令行里的串口是启动那一刻冻下来的。"""
    assert fake.execute("vr.teleop_start")["ok"] is True
    receipt = fake.execute("vr.set_arm_devices", {"devices": {"armA": SPARE_PORT}})
    assert receipt["ok"] is False
    assert receipt["code"] == "Busy"
    assert fake.state("armA")["arm"]["device"] == FAKE_DEVICES["armA"]


def test_unknown_action_is_rejected(fake: FakeVrSession) -> None:
    with pytest.raises(UnknownCommandError):
        fake.execute("vr.teleport")


# ── 那张红字：桥认的口与真机回的口不符 ──────────────────────────────────────


def test_reported_port_lags_until_the_next_teleop_start(fake: FakeVrSession) -> None:
    """**这条就是臂映射卡存在的理由**，假件必须演得出来。

    开机时跟随服务没跑，真机那条路无话可说（空串）。跑过一次遥操之后它就报着那一次
    开的那个口 —— 这时再改映射，快照当场报新值、真机仍报旧口，卡上就该出红字。
    红字只在**下一次开始遥操**时消失：命令行里的串口是启动那一刻冻下来的。
    """
    assert fake.arm_state("armA")["device"] == ""

    fake.execute("vr.teleop_start")
    assert fake.arm_state("armA")["device"] == FAKE_DEVICES["armA"]
    fake.execute("vr.teleop_stop")

    fake.execute("vr.set_arm_devices", {"devices": {"armA": SPARE_PORT}})
    snapshot = fake.state("armA")
    assert snapshot["arm"]["device"] == SPARE_PORT
    assert fake.arm_state("armA")["device"] == FAKE_DEVICES["armA"]   # 红字的来源

    fake.execute("vr.teleop_start")
    assert fake.arm_state("armA")["device"] == SPARE_PORT            # 红字消失


def test_teleop_switches_the_gate_the_card_reads(fake: FakeVrSession) -> None:
    """映射卡的 `canEdit` 只看两件事：通道在线、且没在跟随。

    所以这两个值必须真的跟着开关走 —— 否则那张卡要么永远能改（改得动正在跑的链路），
    要么永远改不了。
    """
    # ⚠ 头显与遥操开关**不是一回事**：它一直连着、一直推帧。控制卡拿 headsetOnline
    #   当"能不能开始遥操"的闸门，两者绑在一起就是一个点不动的死锁。
    assert fake.state("armA")["headset"]["online"] is True
    assert fake.state("armA")["headset"]["following"] is False
    # 没开遥操时帧照旧进来，只是被桥拦下（`frames_blocked`），一个字节都不转发
    assert fake.state("armA")["headset"]["frames_forwarded"] == 0
    assert fake.state("armA")["headset"]["frames_blocked"] > 0

    fake.execute("vr.teleop_start")
    assert fake.state("armA")["headset"]["following"] is True
    assert fake.state("armA")["link"]["state"] == "following"
    assert fake.arm_state("armA")["connected"] is True

    fake.execute("vr.estop")
    assert fake.state("armA")["headset"]["following"] is False
    assert fake.state("armA")["link"]["rearm_required"] is True
    assert fake.state("armA")["link"]["state"] == "latched"


# ── 接进 daemon：`--fake` 选它，server 照旧 ─────────────────────────────────


def test_fake_flag_selects_the_fake_and_no_zenoh_is_needed(
        monkeypatch: pytest.MonkeyPatch) -> None:
    """`--fake` 下走假件 —— 而且**不 import zenoh**：那条判据必须排在"有没有 zenoh"
    之前，否则没装 zenoh 的机器上 `--fake` 会得到一个空的 VR 通道（页面又变回没法验）。

    这里把 `zenoh` 从模块表里顶掉（`import zenoh` 拿到 None 就抛 ImportError），
    于是"这条路真的没碰 zenoh"是被证出来的，而不是靠"这台机器恰好没装"。
    """
    monkeypatch.setitem(sys.modules, "zenoh", None)
    args = Namespace(no_vr=False, fake=True, vr_endpoint=None)
    session = daemon_main.build_vr_session(args)
    try:
        assert isinstance(session, FakeVrSession)
        assert wait_until(lambda: sorted(session.snapshots()) == ["armA", "armB"])
    finally:
        session.close()


def test_no_vr_still_wins_over_fake() -> None:
    """显式要求不起 VR 通道时，假件也不该起来（那条选择比 `--fake` 更具体）。"""
    assert daemon_main.build_vr_session(
        Namespace(no_vr=True, fake=True, vr_endpoint=None)) is None


def test_handshake_carries_the_fake_channel() -> None:
    """接进 server：新窗口一连上就该拿到 `vr_conn` 与每条臂的快照，

    否则页面要等下一拍（100ms）才画出 3D 与映射那两行。
    """
    fake = FakeVrSession()
    fake.start()
    session = Session(port_finder=lambda: None)
    app = create_app(session, vr=fake)
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                assert ws.receive_json()["t"] == "hello"
                frames = _collect(ws, want=lambda got: (
                    any(f["t"] == "vr_conn" for f in got)
                    and len([f for f in got if f["t"] == "vr_state"]) >= 2))
    finally:
        fake.close()
    conn = next(f for f in frames if f["t"] == "vr_conn")
    assert conn["status"] == "connected"
    assert conn["arms"] == ["armA", "armB"]
    states = [f for f in frames if f["t"] == "vr_state"]
    assert {f["arm"] for f in states} == {"armA", "armB"}


def test_vr_command_round_trip_through_the_server() -> None:
    """从 socket 打一条 `vr.set_arm_devices` 进去，回执原样出来 ——

    页面读的是 `res.v.receipt.result.applied`（见 `useArmManifest` 的 `save`），
    这条路径断了的话那张卡的保存按钮就只会转圈。
    """
    fake = FakeVrSession()
    fake.start()
    session = Session(port_finder=lambda: None)
    app = create_app(session, vr=fake)
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()                      # hello
                _drain_until_res(ws, {
                    "t": "cmd", "id": 1, "m": "vr.set_arm_devices",
                    "p": {"devices": {"armB": SPARE_PORT}},
                })
    finally:
        fake.close()


def _collect(ws: Any, *, want: Any, limit: int = 40) -> list[dict]:
    """读到 `want(frames)` 成立为止。

    不数固定条数：握手那几帧之间还会插进别的（`log_meta`、日志流），数条数的用例
    迟早会因为一条无关的帧而红。
    """
    frames: list[dict] = []
    for _ in range(limit):
        frames.append(ws.receive_json())
        if want(frames):
            return frames
    raise AssertionError(f"没有等到想要的帧（已读 {limit} 条）：{[f['t'] for f in frames]}")


def _drain_until_res(ws: Any, frame: dict) -> Optional[dict]:
    ws.send_json(frame)
    for _ in range(60):
        got = ws.receive_json()
        if got.get("t") == "res" and got.get("id") == frame["id"]:
            assert got["ok"] is True, got
            receipt = got["v"]["receipt"]
            assert receipt["result"]["applied"] == ["armB"]
            return got
    raise AssertionError("没有等到 res 帧")
