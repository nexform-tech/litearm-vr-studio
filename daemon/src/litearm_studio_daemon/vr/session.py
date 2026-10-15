"""VR 通道：连 `litearm-vr-bridge` 的 zenoh 那条边（桥自己的 DESIGN §4）。

    litearm/v4/{臂}/vr_status   桥 pub       → 本会话订阅（整包覆盖式快照，10Hz/臂）
    litearm/v4/{臂}/vr_rpc      桥 queryable ← 本会话 query（动作，一问一答）

**为什么在 daemon 里、而不是前端直连**：前端跑在浏览器/webview 里，说不了原生
zenoh —— 要它说只能经一台带 remote-api 插件的 router（Windows 上得自己编）。
daemon 是 Python，`eclipse-zenoh` 一个包就能直连桥的 zenoh 监听端点：
**不需要 router、也不需要插件**。前端照旧走它跟 daemon 之间那条本机 ws，
只是多了两种帧（`vr_conn` / `vr_state`）。

**连接态只能靠"收不收得到快照"判断**：client 模式下 `zenoh.open()` 立刻返回，
真正的"连上"没有事件可等（与桥的 `ctl` 同一个道理）。所以 `status` 是
connecting（线程刚起）→ waiting（会话开了、还没有快照）→ connected（快照在流），
桥不在时停在 waiting 并**一直等**（zenoh 自己会重连）。

**线程**：打开会话与订阅在自己的线程上（可能要等对端，不能堵住事件循环）；
订阅回调跑在 zenoh 的线程上，所以监听器**照夹爪那条规矩** —— 由 server 侧切回
事件循环（`broadcast_threadsafe`），这条线程上不做重活。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable, Optional

from ..errors import UnknownCommandError, VrBridgeUnreachableError

log = logging.getLogger(__name__)

__all__ = ["VrSession", "DEFAULT_ENDPOINT", "ACTIONS", "STATUS_KEYEXPR"]

#: 桥的 zenoh 监听端点。同机部署就是它（桥默认听 `tcp/0.0.0.0:7447`）；
#: 桥在另一台机器上时填 `tcp/<主机>:7447`。
DEFAULT_ENDPOINT = "tcp/127.0.0.1:7447"

#: 快照的 key expression：`*` 吃掉臂那一段 —— 双臂时一条订阅收两条臂的流，
#: 各份快照自带 `arm_id`（桥那边加的），这里按它分流。
STATUS_KEYEXPR = "litearm/v4/*/vr_status"

#: 这么久没快照就算"桥不在线"。桥自己按 10Hz 推，所以这是很宽的余量。
SNAPSHOT_STALE_S = 3.0

#: 动作的应答上限。**别比桥那边小**：桥的 `ZENOH_REPLY_TIMEOUT_S` 默认 20s
#: （冷启动 `teleop.start` 要等端口 + 等上游，十几秒），调小了会出现
#: "动作其实成功了、这边报超时"。
RPC_TIMEOUT_S = 22.0

#: 会话打开失败时的告警节流（每 30s 记一条，别把日志刷爆）。
_REOPEN_LOG_S = 30.0

#: `zenoh.open()` 里那次连接的等待上限。**必须给**：不给的话，端点没人听时
#: `open()` 会一直等下去 —— 于是 `close()` 永远 join 不回来，进程退出时挂住
#: （实测：5s 的收尾超时打满）。给了它，桥不在时这里几秒内就返回并如实报
#: `waiting/error`，之后按 `_RETRY_S` 重试。
_CONNECT_TIMEOUT_MS = 3000

#: 打不开会话时的重试间隔。
_RETRY_S = 5.0

#: `vr.*` 命令 → 桥的动作名。这三个都是**整机动作**：桥那边任何一条臂的话题收到
#: 都作用到整条链路（安全动作不做半边），所以发给哪条臂都一样。
ACTIONS = {
    "vr.teleop_start": "teleop.start",
    "vr.teleop_stop": "teleop.stop",
    "vr.estop": "estop",
}


class VrSession:
    """到桥的一条 zenoh 通道：订快照、发动作。"""

    def __init__(self, *, endpoint: str = DEFAULT_ENDPOINT,
                 arm_hint: str = "armA") -> None:
        self._endpoint = endpoint
        #: 还没收到任何快照时，动作发给谁（约定里的第一条臂）。
        self._arm_hint = arm_hint
        self._lock = threading.RLock()
        self._listeners: list[Callable[[dict], None]] = []
        #: connecting → waiting → connected；打不开会话是 error（并不断重试）。
        self._status = "connecting"
        self._error: Optional[str] = None
        self._snapshots: dict[str, dict] = {}
        self._last_rx: Optional[float] = None
        self._session: Any = None
        self._subscriber: Any = None
        self._thread: Optional[threading.Thread] = None
        self._closing = False
        self._wake = threading.Event()

    # ------------------------------------------------------------------ 生命周期
    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="litearm-vr-session",
                                        daemon=True)
        self._thread.start()

    def _run(self) -> None:
        """开会话、订快照，然后守着连接态 —— 直到 `close()`。"""
        import zenoh

        opened_at = 0.0
        while not self._closing:
            try:
                session = zenoh.open(_client_config(zenoh, self._endpoint))
            except Exception as exc:  # noqa: BLE001 - 打不开就退避重试, 不掀桌子
                self._fail(f"打不开 zenoh 会话（{self._endpoint}）："
                           f"{type(exc).__name__}: {exc}")
                self._wake.wait(_RETRY_S)
                self._wake.clear()
                continue
            try:
                subscriber = session.declare_subscriber(STATUS_KEYEXPR, self._on_sample)
            except Exception as exc:  # noqa: BLE001
                self._fail(f"订阅 {STATUS_KEYEXPR} 失败：{type(exc).__name__}: {exc}")
                _quiet_close(session)
                self._wake.wait(_RETRY_S)
                self._wake.clear()
                continue

            with self._lock:
                self._session = session
                self._subscriber = subscriber
                if self._status != "connected":
                    self._status = "waiting"
                self._error = None
            self._publish_conn()
            opened_at = time.monotonic()
            log.info("VR 通道已开启：%s（订 %s）", self._endpoint, STATUS_KEYEXPR)

            while not self._closing:
                self._wake.wait(0.5)
                self._wake.clear()
                self._refresh_status()

            with self._lock:
                self._subscriber = None
                self._session = None
            _quiet_close(subscriber)
            _quiet_close(session)
            log.info("VR 通道已关闭（%s）", self._endpoint)

    def close(self, timeout_s: float = 5.0) -> None:
        """停线程。同步阻塞 —— 从事件循环调用请用 `to_thread`。"""
        self._closing = True
        self._wake.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout_s)
            if thread.is_alive():
                log.warning("VR 通道线程 %.1fs 内没停下来，不再等它", timeout_s)

    # ------------------------------------------------------------------ 观测
    def conn_info(self) -> dict:
        """`vr_conn` 帧的载荷（不含 `t`），与 `gripper_conn` 同构。"""
        with self._lock:
            status, error, last = self._status, self._error, self._last_rx
            arms = sorted(self._snapshots)
        return {
            "status": status,
            "endpoint": self._endpoint,
            "arms": arms,
            "lastStateAgeMs": (
                None if last is None else round((time.monotonic() - last) * 1000.0, 1)
            ),
            "error": error,
        }

    def state(self, arm: Optional[str] = None) -> Optional[dict]:
        """最近一份快照（`arm` 省略时取第一条臂）。**逐字**是桥推来的那份。"""
        with self._lock:
            if arm is None:
                arm = sorted(self._snapshots)[0] if self._snapshots else None
            return None if arm is None else self._snapshots.get(arm)

    def snapshots(self) -> dict[str, dict]:
        with self._lock:
            return dict(self._snapshots)

    @property
    def endpoint(self) -> str:
        return self._endpoint

    @property
    def status(self) -> str:
        with self._lock:
            return self._status

    def add_listener(self, cb: Callable[[dict], None]) -> None:
        """注册帧监听器。**在 zenoh 的线程上被调用** —— 要快。"""
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
        """`vr.*` → 桥的 `vr_rpc`（query，等回执）。

        回执**原样**返回桥那份（`{"ok": ..., "code": ..., "result"/"error": ...}`）：
        判据在桥那边（`ok` 取自下发给跟随服务的每条命令的结果），这边不替它翻译。
        桥没回执时抛 `VrBridgeUnreachableError` —— 与"桥听见了但拒绝"分开，
        这正是用 query 而不是 pub 换来的那条区分。
        """
        action = ACTIONS.get(method)
        if action is None:
            raise UnknownCommandError(method, sorted(ACTIONS))
        params = params or {}
        with self._lock:
            session = self._session
            arm = sorted(self._snapshots)[0] if self._snapshots else self._arm_hint
        if session is None:
            raise VrBridgeUnreachableError(self._endpoint, action, "会话还没开起来")

        import zenoh

        payload = {"action": action}
        payload.update({k: v for k, v in params.items() if k != "action"})
        topic = f"litearm/v4/{arm}/vr_rpc"
        try:
            replies = session.get(
                topic,
                payload=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                timeout=RPC_TIMEOUT_S,
                # **不收合并**：桥的动作是"这条命令到底送到没有"，合并会把
                # "没人在听" 变成 "等很久才有回音"（同桥自己的 ctl）。
                consolidation=zenoh.QueryConsolidation(zenoh.ConsolidationMode.NONE),
            )
            for reply in replies:
                ok = getattr(reply, "ok", None)
                if ok is None:
                    continue
                try:
                    parsed = json.loads(bytes(ok.payload))
                except (ValueError, TypeError):
                    continue
                if isinstance(parsed, dict):
                    return parsed
        except VrBridgeUnreachableError:
            raise
        except Exception as exc:  # noqa: BLE001 - 连不上/超时都归成"没回执"
            raise VrBridgeUnreachableError(
                self._endpoint, action, f"{type(exc).__name__}: {exc}") from exc
        raise VrBridgeUnreachableError(self._endpoint, action, "没有回执")

    # ------------------------------------------------------------------ 内部
    def _on_sample(self, sample: Any) -> None:
        """zenoh 的订阅回调（zenoh 的线程）。只做解析 + 投递。"""
        try:
            snap = json.loads(bytes(sample.payload).decode("utf-8", "replace"))
        except (ValueError, TypeError):
            log.debug("VR 快照不是 JSON，丢弃")
            return
        if not isinstance(snap, dict):
            return
        arm = str(snap.get("arm_id") or _arm_of(str(sample.key_expr)) or self._arm_hint)
        now = time.monotonic()
        with self._lock:
            self._snapshots[arm] = snap
            self._last_rx = now
            became_online = self._status != "connected"
            if became_online:
                self._status = "connected"
                self._error = None
        if became_online:
            self._publish_conn()
        self._broadcast({"t": "vr_state", "stamp": round(now, 4), "arm": arm,
                         "state": snap})

    def _refresh_status(self) -> None:
        """守着连接态：快照过期就退回 waiting（桥挂了不该一直显示"在线"）。"""
        with self._lock:
            last, status = self._last_rx, self._status
        if status != "connected" or last is None:
            return
        if (time.monotonic() - last) <= SNAPSHOT_STALE_S:
            return
        with self._lock:
            self._status = "waiting"
        self._publish_conn()

    def _fail(self, message: str) -> None:
        """会话打不开：如实报，并**节流**记日志（每 30s 一条）。"""
        with self._lock:
            self._status = "error"
            self._error = message
        self._publish_conn()
        now = time.monotonic()
        if now - getattr(self, "_last_fail_log", 0.0) >= _REOPEN_LOG_S:
            self._last_fail_log = now
            log.warning("VR 通道不可用：%s（会自己重试）", message)

    def _publish_conn(self) -> None:
        self._broadcast({"t": "vr_conn", **self.conn_info()})

    def _broadcast(self, event: dict) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for cb in listeners:
            try:
                cb(event)
            except Exception:  # noqa: BLE001 - a broken listener is not the session's
                log.warning("VR 事件监听器抛出异常 (已忽略)", exc_info=True)


def _client_config(zenoh: Any, endpoint: str) -> Any:
    """client 模式直连桥的监听端点 —— **不经过 router**（那是给浏览器的）。

    scouting 全关：固定拓扑，别让"连不上"变成"连上了别的什么"（同桥的 `ctl`）。
    """
    config = zenoh.Config()
    config.insert_json5("mode", '"client"')
    config.insert_json5("connect/endpoints", json.dumps([endpoint]))
    # 端点没人听时别干等（见 `_CONNECT_TIMEOUT_MS`）
    config.insert_json5("connect/timeout_ms", str(_CONNECT_TIMEOUT_MS))
    config.insert_json5("scouting/multicast/enabled", "false")
    config.insert_json5("scouting/gossip/enabled", "false")
    return config


def _quiet_close(obj: Any) -> None:
    if obj is None:
        return
    try:
        obj.undeclare()
    except Exception:  # noqa: BLE001
        pass


def _arm_of(key_expr: str) -> Optional[str]:
    """从 `litearm/v4/armA/vr_status` 里取臂那一段（快照没带 `arm_id` 时的回退）。"""
    parts = key_expr.split("/")
    return parts[2] if len(parts) > 3 and parts[0] == "litearm" else None
