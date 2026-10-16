"""`VrSession` 的假件 —— `--fake` 下顶上那条 zenoh 通道（无桥、无头显、无真机）。

为什么要有一个假件：这一页的每个数字都来自 `litearm-vr-bridge`（经 daemon 的 zenoh
通道转出来），而现场之外要凑齐「桥 + 头显 + metavr + 跟随服务 + 真机」是不可能的。
夹爪那条路早就照这条规矩办了（`gripper/backend/sim.py`，见 `docs/GRIPPER_INTEGRATION.md`
§5.5：「`--fake` must cover the gripper too, or the page is untestable in CI」）——
VR 是第三条设备通道，同样要能被 `--fake` 覆盖。否则**臂映射那张卡**在没有桥的机器上
永远是空的，而它恰恰是这一页唯一**会改机器去向**的入口。

它与 `session.VrSession` **同形**（`start` / `close` / `conn_info` / `state` /
`snapshots` / `add_listener` / `remove_listener` / `execute`），所以 `server` 那边不需要
知道自己在跟谁说话。帧的形状与动作的回执都照桥的原样给（`receipt.py` 的
`{ok, code, result}` / `{ok: false, code, error}`），连**拒绝时的原话**也照抄 —— 卡片要
显示的就是那句话本身，翻成"保存失败"就什么都没说。

**它一个人演两个角色**：真链路上 `vr_state` 是桥发的，`vr_arm` / `vr_grip` 是上游那台
状态汇总服务发的（两台东西）—— 对页面来说它们只是四种帧，所以这里合在一个假件里。

**两条臂、两个夹爪**：`vr_arm` / `vr_grip` 都按臂各发一份 —— 两条臂就可能是两个夹爪，
各自一个 CAN 口（见 `FAKE_GRIPPER_CHANNELS`）。挤成一份的话，双臂部署下页面会把两个
夹爪的读数看成一个。

演出来的那条线，与卡上写的操作顺序一致：

    开机            两条臂，各带一个夹爪（臂是串口、夹爪是 CAN 口）；跟随服务没跑
                    （`vr_arm` 报断开）—— 这时才改得动
    改一个口 + 保存   只该改动的那条变成「已确认」；真机那行还是旧口 ⇒ 卡上出**红字**
    开始遥操         跟随服务起来、开的正是新口 ⇒ 红字消失，负载与 3D 有数了；
                     同时映射卡因为 `following` 变灰（改不了，与真桥同一判据）
    停止遥操         回到可改状态，真机仍报最后开过的那个口

臂与夹爪的口是**一条记录**（同 `litearm-vr-bridge` 的 `manifest`）：`vr.set_arm_devices`
一次收 `devices` 与 `grippers` 两张表。

⚠ **它不碰 zenoh、不碰桥，也不写任何记录文件**：改动只活在这个进程的内存里（桥那边是
   落盘的，换台上位机连过去看到的是同一份）。所以它证明得了「页面的交互是对的」，证明
   不了「桥会照做」—— 后者只能在现场或有桥的台架上走。

⚠ **没有演的东西**：兜底（fallback）、帧停顿、事件流、进程崩溃、双臂之外的臂数、
   **没有夹爪的臂**（假件里两条臂都带夹爪，所以界面上"这条臂没有夹爪"那一档在这儿看不见）。
   这一版只求把「看状态 + 改映射 + 按开关」这条主线走通。
"""
from __future__ import annotations

import math
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from ..errors import UnknownCommandError
from .session import ACTIONS

__all__ = ["FakeVrSession", "FAKE_ARMS", "FAKE_PORTS", "FAKE_VERSION"]

#: 桥报的版本。页面拿它跟 `SUPPORTED_BRIDGE_VERSION`（`0.1`，见 `bridgeCompat.ts`）比，
#: 对不上就出一行"版本可能对不上"的提醒 —— 假件不该把操作员引到那条提醒上去，
#: 所以照页面认的那个 major.minor 报。
FAKE_VERSION = "0.1.0-fake"

#: 假件的两条臂：(身份, 左右)。两条而不是一条：臂映射卡的价值就在"哪条口接在哪条臂"，
#: 一条臂既看不出左右、也试不出"同一个口指给两条臂"那条拒绝。
FAKE_ARMS: tuple[tuple[str, str], ...] = (("armA", "left"), ("armB", "right"))

#: 开机时两个口：两条臂各占一个 CDC 串口。
#:
#: ⚠ 这里**故意不给 `/dev/serial/by-id/…`**（那是桥的候选列表里"稳定的名字"那一类，
#:   现场该选的就是它）。假件要的是"一眼看出谁是谁、换起来看得出变化"，而 by-id 的名字
#:   又长又只在末尾差一两个字符，摆在假数据里反而看不清。
FAKE_DEVICES = {
    "armA": "/dev/ttyACM0",
    "armB": "/dev/ttyACM1",
}

#: 两条臂各带一个夹爪，所以 CAN 口也是两个（夹爪走 CAN，不是串口）。
#: 身份与臂一一对应：`armA` 的夹爪在 `can0`、`armB` 的在 `can1`。
FAKE_GRIPPER_CHANNELS = {"armA": "can0", "armB": "can1"}


#: `ports.list` 的候选口：两类、四个。臂是串口（`serial`）、夹爪是 CAN（`can`）。
FAKE_PORTS: tuple[dict[str, str], ...] = (
    {"path": FAKE_DEVICES["armA"], "kind": "serial"},
    {"path": FAKE_DEVICES["armB"], "kind": "serial"},
    {"path": "can0", "kind": "can"},
    {"path": "can1", "kind": "can"},
)

#: 假件的配置面。**照桥的 `configfile.CONFIG_KEYS` 抄一份小样**：每一档（立即 / 重建
#: 命令行 / 需重启）、每一种控件（布尔 / 枚举 / 文本）、以及"不给改的键"都各留一个 ——
#: 假件的作用是"没有桥的机器上也能把页面点一遍"，那就得把每一档都点到。
#: 真链路上这份东西是桥下发的（`config.schema`），页面对它一无所知。
FAKE_CONFIG: tuple[dict[str, Any], ...] = (
    {"path": "machine.real", "section": "machine", "key": "real", "kind": "bool",
     "values": [], "apply": "respec", "value": True, "source": "config", "writable": True,
     "locked_why": None,
     "doc": "关闭后仅在仿真环境中运行"},
    {"path": "machine.side", "section": "machine", "key": "side", "kind": "bool",
     "values": [], "apply": "respec", "value": False, "source": "default", "writable": True,
     "locked_why": None,
     "doc": ""},
    {"path": "machine.viewer", "section": "machine", "key": "viewer", "kind": "enum",
     "values": ["gui", "rviz"], "apply": "respec", "value": "gui", "source": "default",
     "writable": True, "locked_why": None, "doc": ""},
    {"path": "follow.ctrl_mode", "section": "follow", "key": "ctrl_mode", "kind": "text",
     "values": [], "apply": "respec", "value": "js", "source": "default", "writable": True,
     "locked_why": None, "doc": "jf | js | j | mit，对应上游 --mode；jf 需板上固件 ≥ 1.9.0"},
    {"path": "bridge.log_level", "section": "bridge", "key": "log_level", "kind": "enum",
     "values": ["DEBUG", "INFO", "WARNING", "ERROR"], "apply": "live", "value": "INFO",
     "source": "default", "writable": True, "locked_why": None,
     "doc": "修改后立即生效"},
    {"path": "bridge.log_format", "section": "bridge", "key": "log_format", "kind": "enum",
     "values": ["text", "json"], "apply": "restart", "value": "text", "source": "default",
     "writable": True, "locked_why": None, "doc": ""},
    {"path": "safety.require_real_ack", "section": "safety", "key": "require_real_ack",
     "kind": "bool", "values": [], "apply": "locked", "value": False, "source": "default",
     "writable": False,
     "locked_why": "它拦的就是这个页面。页面能自己把它关掉，等于没有。",
     "doc": ""},
    {"path": "bridge.zenoh_listen", "section": "bridge", "key": "zenoh_listen",
     "kind": "text", "values": [], "apply": "locked", "value": "tcp/127.0.0.1:7447",
     "source": "default", "writable": False,
     "locked_why": "改了会把上位机自己踢下线：话题换一段、端点换一个，连回执都送不回来。"
                   "现场表现是「点了一下，页面从此连不上，不知道为什么」。",
     "doc": ""},
)

#: 臂清单里那份"这台机器认哪几条臂"的顺序（照身份排序，与 `conn_info().arms` 一致）。
_ARM_IDS: tuple[str, ...] = tuple(arm for arm, _ in FAKE_ARMS)
_SIDES: dict[str, str] = dict(FAKE_ARMS)

#: 就地持位时的关节角（rad，7 轴）。照 `__fixtures__/armStatus.ts` 里那份真抓的抄。
_HOLD_Q: tuple[float, ...] = (0.0, -0.07, -0.09, -1.7, -1.46, -0.03, -0.79)

#: 跟随中摆动多少 —— 每轴一个幅度，只为了让 3D 与负载读数看得出在动。
_SWING_Q: tuple[float, ...] = (0.05, 0.08, 0.06, 0.12, 0.10, 0.04, 0.03)

#: 逐轴额定 |tau| 的参照值，只用来把假力矩摆在一个像样的量级上（N·m）。
_TAU_SCALE: tuple[float, ...] = (3.4, 3.4, 2.6, 2.6, 1.4, 1.4, 1.4)

#: 推帧的间隔。真链路上桥按 10Hz 推快照、上游汇总按 100Hz 推真机状态；这边一律 10Hz ——
#: 页面那头本来就按 100ms 节流（见 `vrDaemonClient` 的 `NOTIFY_INTERVAL_MS`），
#: 再快只是让假件自己烧 CPU。
TICK_S = 0.1


def _now_iso() -> str:
    """记录里的确认时间 —— 与桥的 `manifest._now_iso()` 同一个写法。"""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _receipt(code: str, result: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """成功回执。**没有 `commands`**：假件底下没有跟随服务，编一条命令结果出来
    等于谎报"下游接住了"。形状与桥的 `receipt()` 在有命令时一致，只是 `result` 里
    少了那份 `commands`。
    """
    return {"ok": True, "code": code, "result": dict(result or {})}


def _receipt_error(code: str, message: str) -> dict[str, Any]:
    """失败回执。`message` 是**给操作员看的那句话**（卡片原样显示），照桥的原话抄。"""
    return {"ok": False, "code": code, "error": {"type": code, "message": message,
                                                 "details": {}}}


class FakeVrSession:
    """`--fake` 的 VR 通道：自己推四种帧，自己应答八条动作。

    ⚠ 线程模型与真件**一致**：`add_listener` 注册的回调在**本假件自己的线程**上被调用，
       不是事件循环线程 —— 所以 `server` 那边照旧用 `broadcast_threadsafe` 投递，
       这条纪律在假件上也是真的在跑，不是"只有真桥才走得到"的死代码。
    """

    def __init__(self, *, endpoint: str = "fake", tick_s: float = TICK_S) -> None:
        self._endpoint = endpoint
        self._tick_s = max(0.02, float(tick_s))
        self._lock = threading.RLock()
        self._listeners: list[Callable[[dict], None]] = []
        self._snapshots: dict[str, dict] = {}
        self._arm_states: dict[str, dict] = {}
        self._grip_states: dict[str, dict] = {}
        #: 这台机器认的口（快照的 `arm.device`）与它**是谁定的**。
        #: 一条 `config`（装机时写下的默认）、一条 `record`（操作员按实物确认过的）——
        #: 开机就是这个样子，界面上那两行本来就不该长得一样。
        self._devices: dict[str, dict[str, Any]] = {
            "armA": {"device": FAKE_DEVICES["armA"], "gripper": FAKE_GRIPPER_CHANNELS["armA"],
                     "source": "config", "confirmed_at": None},
            "armB": {"device": FAKE_DEVICES["armB"], "gripper": FAKE_GRIPPER_CHANNELS["armB"],
                     "source": "record", "confirmed_at": _now_iso()},
        }
        #: 真机那条路报的口 = 跟随服务**实际开过**的那个。没跑过就是空串 ——
        #: 开机时它没有任何东西可报（见模块文档的那条线）。
        self._reported: dict[str, str] = {arm: "" for arm in _ARM_IDS}
        #: 上位机改过的配置项（桥那边是落盘的 `overrides.json`）。这里只在内存里，
        #: 进程一停就没了 —— 见模块开头那条"它不写任何记录文件"。
        self._overrides: dict[str, Any] = {}
        #: 存了但**还没生效**的键（"重启桥后生效"那一档）。照桥的语义：不套进当前值。
        self._pending: set[str] = set()
        #: 跟随服务在不在跑（改映射的忙判据就是它，同桥的 `_link_busy`）。
        self._running = False
        #: 手柄在不在跟随（`headset.following`）—— 映射卡的 `canEdit` 看这个。
        self._following = False
        self._rearm = False
        self._frames = 0
        self._started_mono = time.monotonic()
        #: 最后一拍的时刻（`vr_conn` 的 `lastStateAgeMs` 用它，与真件同义：
        #: 页面据此判断"快照还在不在流"，所以不能拿进程启动时刻顶上）。
        self._last_tick = self._started_mono
        self._thread: Optional[threading.Thread] = None
        self._closing = False
        self._wake = threading.Event()

    # ------------------------------------------------------------------ 生命周期
    def start(self) -> None:
        """起假件：先把第一拍摆好（新窗口要立刻有东西可画），再推帧。"""
        if self._thread is not None:
            return
        self._started_mono = time.monotonic()
        with self._lock:
            self._refresh_locked(self._started_mono)
        self._thread = threading.Thread(target=self._run, name="litearm-vr-fake",
                                        daemon=True)
        self._thread.start()

    def close(self, timeout_s: float = 5.0) -> None:
        """停线程。同步阻塞 —— 与真件同签名（调用方照旧可以直接调）。"""
        self._closing = True
        self._wake.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout_s)

    def _run(self) -> None:
        while not self._closing:
            self._wake.wait(self._tick_s)
            self._wake.clear()
            if self._closing:
                return
            self._publish_frames()

    # ------------------------------------------------------------------ 观测
    def conn_info(self) -> dict:
        """`vr_conn` 帧的载荷（不含 `t`）。假件没有"连不上"这一档：它一起就是通的。"""
        with self._lock:
            arms = sorted(self._snapshots)
            last = self._last_tick
        return {
            "status": "connected",
            "endpoint": self._endpoint,
            "arms": arms,
            "lastStateAgeMs": round((time.monotonic() - last) * 1000.0, 1),
            "error": None,
        }

    def state(self, arm: Optional[str] = None) -> Optional[dict]:
        with self._lock:
            if arm is None:
                arm = sorted(self._snapshots)[0] if self._snapshots else None
            return None if arm is None else self._snapshots.get(arm)

    def snapshots(self) -> dict[str, dict]:
        with self._lock:
            return dict(self._snapshots)

    #: 下面两个读口只有假件有（真件那条路上，`vr_arm` / `vr_grip` 是上游汇总直接
    #: 发给前端的，daemon 只是转发，不往回读）。留着是因为"真机到底报的是哪个口"
    #: 正是臂映射卡要跟快照对拍的那件事 —— 用例得能问出这一份来。

    def arm_state(self, arm: str) -> dict:
        with self._lock:
            return dict(self._arm_states.get(arm) or {})

    def grip_state(self, arm: str) -> dict:
        with self._lock:
            return dict(self._grip_states.get(arm) or {})

    @property
    def endpoint(self) -> str:
        return self._endpoint

    @property
    def status(self) -> str:
        return "connected"

    def add_listener(self, cb: Callable[[dict], None]) -> None:
        """注册帧监听器。**在本假件的线程上被调用** —— 与真件同一条纪律，要快。"""
        with self._lock:
            self._listeners.append(cb)

    def remove_listener(self, cb: Callable[[dict], None]) -> None:
        with self._lock:
            try:
                self._listeners.remove(cb)
            except ValueError:
                pass

    # ------------------------------------------------------------------ 动作
    def execute(self, method: str, params: Optional[dict] = None) -> Any:
        """`vr.*` → 回执。判据与话术照桥那边抄（见 `session.ACTIONS` 的名字映射）。"""
        if method not in ACTIONS:
            raise UnknownCommandError(method, sorted(ACTIONS))
        params = params or {}
        if method == "vr.teleop_start":
            return self._start_teleop()
        if method == "vr.teleop_stop":
            return self._stop_teleop(estop=False)
        if method == "vr.estop":
            return self._stop_teleop(estop=True)
        if method == "vr.list_ports":
            return _receipt("ports_listed", {"mode": "stm32",
                                             "ports": [dict(p) for p in FAKE_PORTS]})
        if method == "vr.get_config":
            return self._config_schema()
        if method == "vr.set_config":
            return self._set_config(params.get("config"))
        if method == "vr.reset_config":
            return self._reset_config(params.get("paths"))
        return self._set_arm_devices(params.get("devices"), params.get("grippers"))

    # ------------------------------------------------------------ 配置（通用面）
    def _config_entries(self) -> list[dict[str, Any]]:
        """照桥的 `config.schema` 拼一份：覆盖层压过出厂默认，`source` 跟着变。"""
        out = []
        for spec in FAKE_CONFIG:
            path = spec["path"]
            # ⚠ 「存了但还没生效」的键，**当前值仍是旧的** —— 显示成新值就是
            # "假装已经生效"，而这条档存在的全部意义就是不许假装。来源照样是
            # `override`（覆盖层里确实有它），配上 `pending_restart` 一起看才是实话。
            out.append(dict(
                spec,
                value=(spec["value"] if path in self._pending
                       else self._overrides.get(path, spec["value"])),
                source="override" if path in self._overrides else spec["source"],
                pending_restart=path in self._pending,
            ))
        return out

    def _config_schema(self) -> dict[str, Any]:
        return _receipt("config_schema", {
            # 假件里这两个路径只是"页面上会有这么一行"，不指向真的文件
            "config_file": "/etc/litearm-vr-bridge.toml",
            "overrides_file": "~/.config/litearm-vr-bridge/overrides.json",
            "pending_restart": sorted(self._pending),
            "entries": self._config_entries(),
        })

    def _set_config(self, patch: Any) -> dict[str, Any]:
        if not isinstance(patch, dict):
            return _receipt_error(
                "BadRequest",
                'config.set 需要 config 参数：{段: {键: 值}}，如 {"machine": {"real": false}}')
        known = {spec["path"]: spec for spec in FAKE_CONFIG}
        coerced: dict[str, Any] = {}
        for section, table in patch.items():
            if not isinstance(table, dict):
                return _receipt_error("BadRequest",
                                      f"config.set 的 [{section}] 得是一张表（{{键: 值}}）")
            for key, value in table.items():
                path = f"{section}.{key}"
                spec = known.get(path)
                if spec is None:
                    return _receipt_error(
                        "BadRequest", f"不认识的配置项 {path}（认得的见 config.schema）")
                if not spec["writable"]:
                    return _receipt_error("BadRequest",
                                          f"{path} 不从页面上改 —— {spec['locked_why']}")
                if spec["kind"] == "bool":
                    text = str(value).strip().lower()
                    if text in ("1", "true", "yes", "y", "on"):
                        coerced[path] = True
                    elif text in ("0", "false", "no", "n", "off"):
                        coerced[path] = False
                    else:
                        return _receipt_error("BadRequest",
                                              f"{path} 得是 true / false，拿到 {value!r}")
                else:
                    coerced[path] = str(value)
        if not coerced:
            return _receipt_error("BadRequest", "config.set 没有给任何配置项")

        changed = [path for path, value in coerced.items()
                   if self._overrides.get(path, known[path]["value"]) != value]
        if not changed:
            return _receipt("config_set", {
                "applied": [], "pending_restart": sorted(self._pending),
                "note": "与当前一致，没有改动",
            })
        # 「重启才生效」的键存下来但不套进当前值 —— 与桥同一条规矩
        self._pending |= {p for p in changed if known[p]["apply"] == "restart"}
        for path in changed:
            self._overrides[path] = coerced[path]
        return _receipt("config_set", {
            "changed": sorted(changed),
            "applied": sorted(p for p in changed if p not in self._pending),
            "pending_restart": sorted(self._pending),
            "overrides_file": "（假件：只在内存里）",
            "config": self._config_entries(),
        })

    def _reset_config(self, paths: Any) -> dict[str, Any]:
        if not isinstance(paths, list) or not paths:
            return _receipt_error("BadRequest",
                                  "config.reset 需要 paths：要退回配置文件的那几项")
        known = {spec["path"] for spec in FAKE_CONFIG}
        unknown = [path for path in paths if path not in known]
        if unknown:
            return _receipt_error(
                "BadRequest", f"不认识的配置项 {unknown}（认得的见 config.schema）")
        for path in paths:
            self._overrides.pop(path, None)
            self._pending.discard(path)
        return _receipt("config_reset", {
            "applied": sorted(paths),
            "pending_restart": sorted(self._pending),
            "config": self._config_entries(),
        })

    def _start_teleop(self) -> dict[str, Any]:
        with self._lock:
            self._running = True
            self._following = True
            self._rearm = False
            # 跟随服务起来时开的正是**现在这份映射**：真机那条路从此报的就是它。
            # 这一句就是"红字消失"的全部原因，也是它为什么只能在这一刻消失 ——
            # 桥落的盘要等 follow 重新起才生效（命令行里的串口是启动那一刻冻下来的）。
            for arm in _ARM_IDS:
                self._reported[arm] = self._devices[arm]["device"]
        self._publish_frames()
        return _receipt("teleop_started")

    def _stop_teleop(self, *, estop: bool) -> dict[str, Any]:
        with self._lock:
            self._running = False
            self._following = False
            self._rearm = True
            # 真机那条路报的口**留着**：跟随服务停了，读到的可能还是最后一帧的那几个数
            # （与 `__fixtures__/armStatus.ts` 的 `ARM_DISCONNECTED` 同一个口径）。
        self._publish_frames()
        return _receipt("estop_sent" if estop else "teleop_stopped")

    def _set_arm_devices(self, devices: Any,
                         grippers: Any = None) -> dict[str, Any]:
        """`arms.set` —— 判据与拒绝时的原话照 `litearm-vr-bridge` 的 `set_arm_devices`。

        两样口一起收：`devices` 是臂的串口，`grippers` 是这条臂那个夹爪的 CAN 口。
        两张表都是**部分更新**，一条臂可以只改其中一样。
        """
        # ⚠ 两张表都可以为空，但不能都空：只改夹爪口的保存就是 `devices: {}` +
        #   `grippers: {armA: can0}`（同桥那边的判据）。
        if devices is None:
            devices = {}
        if (not isinstance(devices, dict)
                or (grippers is not None and not isinstance(grippers, dict))):
            return _receipt_error(
                "BadRequest",
                "arms.set 的参数是两张表：devices（{臂身份: 串口}）与 "
                "grippers（{臂身份: CAN 口}）")
        if not devices and not grippers:
            return _receipt_error("BadRequest", "arms.set 需要 devices 参数：{臂身份: 串口}")

        unknown = [key for key in list(devices) + list(grippers or {})
                   if key not in _ARM_IDS]
        if unknown:
            return _receipt_error(
                "BadRequest",
                f"没有这几条臂：{'、'.join(sorted(unknown))}"
                f"（本机是 {'、'.join(sorted(_ARM_IDS))}）",
            )
        updates: dict[str, str] = {}
        for arm_id, value in devices.items():
            if not isinstance(value, str) or not value.strip():
                return _receipt_error(
                    "BadRequest", f"{arm_id} 的串口是个空值：每条臂都得指认一个口")
            updates[arm_id] = value.strip()
        grip_updates: dict[str, str] = {}
        for arm_id, value in (grippers or {}).items():
            if not isinstance(value, str) or not value.strip():
                return _receipt_error(
                    "BadRequest", f"{arm_id} 的夹爪口是个空值：要么给它一个 CAN 口，"
                                  "要么这一次别动它")
            grip_updates[arm_id] = value.strip()

        with self._lock:
            # 部分更新：没提到的保持原值 —— 但要**按更新后**的整套查重，否则"只改一条"
            # 就能把两条臂改成同一个口，而那正是"两条 follow 抢一个串口、谁也不报错"。
            effective = {
                arm: updates.get(arm, self._devices[arm]["device"]) for arm in _ARM_IDS
            }
            values = list(effective.values())
            clash = sorted({v for v in values if values.count(v) > 1})
            if clash:
                return _receipt_error(
                    "BadRequest",
                    f"同一个口被指给了两条臂（{clash[0]}）：一个串口只能有一条 follow 开 —— "
                    "选错会静默地让两条臂对调",
                )
            # 夹爪那张表同理：一个 CAN 口只能开一个夹爪
            grip_effective = {
                arm: grip_updates.get(arm, self._devices[arm]["gripper"])
                for arm in _ARM_IDS
            }
            grip_values = list(grip_effective.values())
            grip_clash = sorted({v for v in grip_values if v and grip_values.count(v) > 1})
            if grip_clash:
                return _receipt_error(
                    "BadRequest",
                    f"同一个 CAN 口被指给了两个夹爪（{grip_clash[0]}）："
                    "一个口只能开一个夹爪 —— 选错会静默地让两个夹爪对调",
                )

            changed = sorted(
                arm for arm in _ARM_IDS
                if effective[arm] != self._devices[arm]["device"]
                or grip_effective[arm] != self._devices[arm]["gripper"]
            )
            if not changed:
                return _receipt("arms_set", {"arms": self._arm_view(),
                                             "applied": [],
                                             "note": "与当前一致，没有改动"})
            # 忙判据与桥一致：上游进程还在跑就不能改（命令行是启动那一刻冻下来的）
            if self._running:
                return _receipt_error(
                    "Busy",
                    "teleop 正在运行：命令行里的串口是**启动那一刻冻下来的**，"
                    "现在改只会让界面和真机说的不一样。先停掉它们（`--ctl down`）再改",
                )
            for arm in changed:
                # 确认过的口盖住装机默认（`record` 压 `config`，与桥的 manifest 同一条
                # 规矩）；口没变的那几条不动 —— 顺手重写等于替操作员又签了一次字。
                self._devices[arm] = {"device": effective[arm],
                                      "gripper": grip_effective[arm],
                                      "source": "record", "confirmed_at": _now_iso()}
            applied = list(changed)
        self._publish_frames()
        return _receipt("arms_set", {"arms": self._arm_view(), "applied": applied})

    def _arm_view(self) -> list[dict[str, Any]]:
        """臂清单给人看的样子（回执里的 `arms`，与桥的 `_arm_view()` 同形）。"""
        with self._lock:
            return [
                {
                    "arm_id": arm,
                    "side": _SIDES[arm],
                    "device": self._devices[arm]["device"],
                    "gripper": self._devices[arm]["gripper"],
                    "device_source": self._devices[arm]["source"],
                    "device_confirmed_at": self._devices[arm]["confirmed_at"],
                    "follow": "127.0.0.1:9001",
                }
                for arm in _ARM_IDS
            ]

    # ------------------------------------------------------------------ 帧
    def _publish_frames(self) -> None:
        """推一拍：快照 + 真机状态（两种帧都是**每条臂一份**）。"""
        now = time.monotonic()
        with self._lock:
            self._refresh_locked(now)
            frames = [
                {"t": "vr_state", "stamp": round(now, 4), "arm": arm,
                 "state": self._snapshots[arm]}
                for arm in _ARM_IDS
            ] + [
                {"t": "vr_arm", "stamp": round(now, 4), "arm": arm,
                 "state": self._arm_states[arm]}
                for arm in _ARM_IDS
            ] + [
                {"t": "vr_grip", "stamp": round(now, 4), "arm": arm,
                 "state": self._grip_states[arm]}
                for arm in _ARM_IDS
            ]
        for frame in frames:
            self._broadcast(frame)

    def _refresh_locked(self, now: float) -> None:
        """重新算一遍三个"每臂一份"的载荷（调用方持锁）。"""
        self._last_tick = now
        # 头显一直在推帧（停不停遥操都一样），所以这个计数无条件涨
        self._frames += 1
        for index, arm in enumerate(_ARM_IDS):
            self._snapshots[arm] = self._snapshot_locked(arm, now)
            self._arm_states[arm] = self._arm_state_locked(arm, index, now)
            self._grip_states[arm] = self._grip_state_locked(arm, index)

    def _snapshot_locked(self, arm: str, now: float) -> dict[str, Any]:
        device = self._devices[arm]
        following = self._following
        running = self._running
        # 状态机与桥同一套名字（DESIGN 6.4）：没开遥操是 idle，停止/急停之后是 latched
        # （就地持位、要重新按 grip 才会继续跟）。
        state = "following" if following else ("latched" if self._rearm else "idle")
        return {
            "ts": int(time.time() * 1000),
            "arm_id": arm,
            "bridge": {
                "online": True,
                "version": FAKE_VERSION,
                "uptime_s": round(now - self._started_mono, 1),
                "forward_cost_ms": 0.1,
                "forward_cost_last_ms": 0.09,
                "forward_cost_max_ms": 0.32,
                "clients": {"headset": 1, "status": 1},
                # teleop（逆解那一跳）是桥管的进程，与遥操开没开无关（`no_headset` 那份
                # 真实固件里它也是 true）。字段名照桥现在的契约写，别用改名前那个
                # `metavr_connected` —— 页面读的是这个名字。
                "teleop_connected": True,
                # 接真机还是只跑仿真 —— **桥那一侧的事实**。页面上"机械臂"那一跳原来
                # 只能从"臂连上了"猜，于是被迫在"真机"与"不知道"之间挤；有了它才说得出
                # "仿真"。跟着配置面走：在假件上改 `machine.real` 这行就跟着翻。
                "real": bool(self._overrides.get("machine.real", True)),
            },
            # ⚠ 头显**一直连着**：它推它的帧，跟"遥操开没开"是两件事 —— 桥停掉转发之后
            #   帧照旧进来，只是被拦下不转发（`frames_blocked` 就是这些）。
            #   这一条不能跟 `_running` 绑在一起：控制卡拿 `headsetOnline` 当"能不能开始
            #   遥操"的闸门（`offline = !vm.headsetOnline`），绑上就成了"要先开始遥操才
            #   能开始遥操"——一个按钮永远点不动的死锁。
            "headset": {
                "online": True,
                "connected": True,
                "following": following,
                "grip": following,
                "tracked": True,
                "fps": 89.9,
                "latency_ms": 12.3,
                "latency_estimated": False,
                "last_frame_age_ms": 4.2,
                "last_frame_ts": int(time.time() * 1000),
                "frames": self._frames,
                "frames_forwarded": self._frames if running else 0,
                "frames_dropped": 0,
                "frames_blocked": 0 if running else self._frames,
                "bad_frames": 0,
            },
            # `arm` 这一段是**身份与去处**，不是真机状态（真机状态在 `vr_arm` 上，
            # 见 `vrLink.ts` 那段"别从快照里读臂的字段"）—— 两处的分工照桥的原样。
            "arm": {
                "side": _SIDES[arm],
                "device": device["device"],
                "device_source": device["source"],
                "device_confirmed_at": device["confirmed_at"],
                "follow": "127.0.0.1:9001",
                # 夹爪的 CAN 口（空 = 这条臂没有夹爪）：它只喂给汇总服务的 `--gripper`
                # 对拍，但错了界面上那个夹爪的身份就错了 —— 所以照样报出来确认
                "gripper": device["gripper"],
                "commands": {"requests": 0, "failures": 0, "last_ok_age_ms": None,
                             "error": None},
            },
            "link": {
                "state": state,
                "enabled": running,
                "forward_enabled": running,
                "rearm_required": self._rearm,
                "warn_ms": 200.0,
                "fallback_ms": 500.0,
            },
            "fallback": {"active": False, "reason": None, "guard_enabled": True},
            "owner": "vr" if following else "none",
            "processes": {
                "teleop": "running" if running else "stopped",
                "follow_server": "running" if running else "stopped",
            },
            "processes_detail": {},
            # 事件流这一版不演（页面也不展示，见 `vrTypes.ts` 的 `VrBridgeEvent`）
            "events": [],
        }

    def _arm_state_locked(self, arm: str, index: int, now: float) -> dict[str, Any]:
        """`vr_arm`：上游那台状态汇总服务发的 `ArmStatus`（字段照 `armStatus.ts` 抄）。

        跟随服务没跑时 `connected` 是假的、`joints` 是 null —— 界面据此写"未连接"，
        而不是拿上一帧的力矩当当前值（那张负载卡的全部意义就在这个区分上）。
        """
        running = self._running
        device = self._reported[arm]
        q = self._q_locked(index, now)
        return {
            "name": arm,
            "device": device,
            "connected": running,
            "ok": running,
            # 哪一版跟随服务（**不是**仿真/真机）—— 页面只从 `connected` 推 `armSource`
            "source": "sdk",
            "state": ("following" if self._following else "holding") if running else None,
            "mode": None,
            "enabled": None,
            "following": self._following if running else None,
            "flags": [],
            "fault": [],
            "joint_fault": None,
            "q": q,
            "joints": self._joints_locked(index, now) if running else None,
            "age_ms": 0.6 if running else None,
            "error": None,
        }

    def _grip_state_locked(self, arm: str, index: int) -> dict[str, Any]:
        """`vr_grip`：那条臂的夹爪读数（负载卡每臂最后一行）。

        ⚠ **按臂各发一份**：两条臂就可能是两个夹爪，各自一个 CAN 口
        （`FAKE_GRIPPER_CHANNELS`）。挤成一份的话，双臂部署下页面会把两个夹爪的读数
        看成一个 —— 而"这一下夹的是哪只手"正是操作员要判断的事。
        形状照上游的 `GripperStatus`（`litearm-vr-follow/status_msgs.py`）。

        ⚠ 报的 `device` 取**记录里那一个**（不是常量）：真链路上汇总服务的 `--gripper`
          是桥在 `arms.set` 之后**当场重启**它才换上去的，所以它报的新口立刻跟上 ——
          与臂那条不同（follow 要等下次开始遥操才重开，那才叫滞后）。
        """
        running = self._running
        return {
            "device": self._devices[arm]["gripper"],
            "connected": running,
            "ok": running,
            "q": round(0.4 + 0.1 * math.sin(time.monotonic() * 0.6 + index), 3)
                 if running else 0.0,
            "tau": round(0.12 * math.sin(time.monotonic() + index), 3) if running else 0.0,
            "enabled": True if running else None,
            "error_code": None,
            "age_ms": 0.6 if running else 0.0,
            "error": None,
        }

    def _q_locked(self, index: int, now: float) -> list[float]:
        """关节角：跟随中缓慢摆动，否则停在持位那组角度上。

        为什么要动：这一页有两处是**靠帧活着**的（3D 预览与负载读数），静止的一组数
        看不出"帧到底有没有在流"，而"帧停了"正是这一页最该看出来的一件事。摆的幅度
        很小，只到"看得出在动"为止。
        """
        if not self._following:
            return list(_HOLD_Q)
        phase = now * 0.8 + index * 1.7
        out = []
        for axis, base in enumerate(_HOLD_Q):
            out.append(round(base + _SWING_Q[axis] * math.sin(phase + axis * 0.6), 4))
        return out

    def _joints_locked(self, index: int, now: float) -> dict[str, Any]:
        """逐轴力矩与温度（负载卡读的就是这三个数组）。"""
        phase = now * 0.8 + index * 1.7
        tau = [round(_TAU_SCALE[axis] * 0.35 * math.sin(phase + axis * 0.6), 3)
               for axis in range(len(_HOLD_Q))]
        return {
            "tau": tau,
            "t_mos": [round(46.0 + 2.0 * math.sin(phase + axis * 0.3), 1)
                      for axis in range(len(_HOLD_Q))],
            "t_coil": [round(44.0 + 2.5 * math.sin(phase + axis * 0.3), 1)
                       for axis in range(len(_HOLD_Q))],
        }

    def _broadcast(self, event: dict) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for cb in listeners:
            try:
                cb(event)
            except Exception:  # noqa: BLE001 - 一个坏监听器不是这个假件的事
                pass
