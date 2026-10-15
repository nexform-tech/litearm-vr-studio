"""直连 follow 的**只读**轮询：真机状态（角度 / 力矩 / 温度）从哪来。

桥不再照下游（它的上游只有头显），所以这份状态由**上位机自己去问**：按桥给的
端点（每条臂快照里的 `arm.follow`，形如 `127.0.0.1:9001`）连上去，发
`{"cmd":"ping"}`，读一行 JSON 回来。

**为什么按端口认臂**：端口是臂清单里唯一不用猜的东西（两条臂天然两个端口），而
follow 自己只知道它开的那个串口（`ping` 回包里的 `port`）—— 它既不知道自己是 A
还是 B，也不该知道（它源码里那句注释写得很直白：*串口即臂的身份，left/right 会
猜错*）。所以这里：**认臂用端口，串口用来核对** —— 回包说它开的是哪个口，跟清单里
这条臂的 `arm.device` 对不对得上；对不上就带上 `mismatch`，那是"清单和现场对不上"
的现场信号。

**只读**：只发 `ping`，绝不发 start / q / movej —— 跟遥操并行跑是安全的。

**帧的形状照上游**：上游的状态汇总（`status_aggregator.py`）发的 `vr_arm` 载荷是
`status_msgs.ArmStatus`：`{device, connected, ok, source, state, mode, enabled,
following, flags, fault, joint_fault, q, target, anchor, cmd_q,
joints{q,dq,tau,t_mos,t_coil,err}, age_ms, error}`（字段叫 `device` 不叫 `name` ——
跟着上游 2026-10-15 的改名）。我们发的**同形**（多两个自己的键：`expected` 与
`mismatch`）—— 哪天改用上游那台汇总服务，前端一行都不用动。
"""

from __future__ import annotations

import json
import logging
import socket
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)

__all__ = ["FollowPoller"]

#: 轮询频率。UI 看力矩/温度够用；再高只是白占 follow 的处理时间（它逐行串行处理）。
DEFAULT_HZ = 5.0
#: 单次 ping 的读写上限。
POLL_TIMEOUT_S = 0.8
CONNECT_TIMEOUT_S = 0.8


@dataclass
class _ArmTarget:
    arm: str
    endpoint: str
    device: str


class FollowPoller:
    """按桥给的端点轮询每条臂的 follow，把状态播给前端。"""

    def __init__(self, *, hz: float = DEFAULT_HZ) -> None:
        self._interval_s = 1.0 / max(hz, 0.1)
        self._lock = threading.RLock()
        self._listeners: list[Callable[[dict], None]] = []
        self._arms: dict[str, _ArmTarget] = {}
        self._socks: dict[str, socket.socket] = {}
        self._buffers: dict[str, bytes] = {}
        self._thread: Optional[threading.Thread] = None
        self._closing = False
        self._wake = threading.Event()

    # ------------------------------------------------------------------ 生命周期
    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="litearm-vr-follow",
                                        daemon=True)
        self._thread.start()

    def close(self, timeout_s: float = 3.0) -> None:
        self._closing = True
        self._wake.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout_s)
            if thread.is_alive():
                log.warning("follow 轮询线程 %.1fs 内没停下来，不再等它", timeout_s)
        with self._lock:
            socks, self._socks = self._socks, {}
        for sock in socks.values():
            _quiet_close(sock)

    # ------------------------------------------------------------------ 输入：桥的快照
    def observe(self, frame: dict) -> None:
        """从桥的 `vr_state` 里学"哪条臂在哪个端点"（别的帧不理）。

        桥的快照里那段 `arm` 是**身份与去处**（`device` 串口、`follow` 端点），
        正好就是这里要的两样东西。
        """
        if frame.get("t") != "vr_state":
            return
        arm = frame.get("arm")
        snapshot = frame.get("state")
        if not isinstance(arm, str) or not isinstance(snapshot, dict):
            return
        spec = snapshot.get("arm")
        if not isinstance(spec, dict):
            return
        endpoint = spec.get("follow")
        if not isinstance(endpoint, str) or not endpoint:
            return
        device = str(spec.get("device") or "")
        with self._lock:
            known = self._arms.get(arm)
            if known is None or known.endpoint != endpoint or known.device != device:
                self._arms[arm] = _ArmTarget(arm, endpoint, device)
                if known is not None and known.endpoint != endpoint:
                    self._drop_socket(arm)   # 端点换了，旧连接作废

    # ------------------------------------------------------------------ 输出
    def add_listener(self, cb: Callable[[dict], None]) -> None:
        """注册帧监听器。**在轮询线程上被调用** —— 要快。"""
        with self._lock:
            self._listeners.append(cb)

    def remove_listener(self, cb: Callable[[dict], None]) -> None:
        with self._lock:
            try:
                self._listeners.remove(cb)
            except ValueError:
                pass

    def arms(self) -> dict[str, str]:
        """当前认到的端点（臂 → `host:port`），排障用。"""
        with self._lock:
            return {arm: target.endpoint for arm, target in self._arms.items()}

    # ------------------------------------------------------------------ 轮询
    def _run(self) -> None:
        while not self._closing:
            started = time.monotonic()
            with self._lock:
                targets = list(self._arms.values())
            for target in targets:
                if self._closing:
                    return
                frame = self._poll(target)
                if frame is not None:
                    self._broadcast(frame)
            self._wake.wait(max(self._interval_s - (time.monotonic() - started), 0.01))
            self._wake.clear()
        with self._lock:
            socks, self._socks = self._socks, {}
        for sock in socks.values():
            _quiet_close(sock)

    def _poll(self, target: _ArmTarget) -> Optional[dict]:
        """一次 ping。任何失败都返回一份 `connected=False` 的载荷（不抛）。"""
        reply: Optional[dict] = None
        error: Optional[str] = None
        try:
            line = self._round_trip(target, {"cmd": "ping"})
            reply = json.loads(line.decode("utf-8", "replace"))
            if not isinstance(reply, dict):
                reply, error = None, "回包不是 JSON 对象"
        except Exception as exc:  # noqa: BLE001 - 读不到就如实报, 别把轮询打断
            self._drop_socket(target.arm)
            error = f"{type(exc).__name__}: {exc}"
        payload = _arm_payload(target, reply, error=error)
        device = str(payload.get("device") or "")
        return {
            "t": "vr_arm",
            "stamp": round(time.monotonic(), 4),
            "arm": target.arm,
            # `expected` 是**清单说它接在哪**（桥那边来的），`device` 是**它自己报的**
            # （回包里的串口）—— 两者不一致就是"清单和现场对不上"，界面要看得见。
            "expected": target.device,
            "mismatch": bool(target.device and device and device != target.device),
            "state": payload,
        }

    def _round_trip(self, target: _ArmTarget, message: dict) -> bytes:
        sock = self._socket_for(target)
        sock.sendall((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        return self._readline(target)

    def _socket_for(self, target: _ArmTarget) -> socket.socket:
        with self._lock:
            sock = self._socks.get(target.arm)
        if sock is not None:
            return sock
        host, _, port = target.endpoint.rpartition(":")
        sock = socket.create_connection((host or "127.0.0.1", int(port)),
                                        timeout=CONNECT_TIMEOUT_S)
        sock.settimeout(POLL_TIMEOUT_S)
        with self._lock:
            self._socks[target.arm] = sock
            self._buffers[target.arm] = b""
        return sock

    def _readline(self, target: _ArmTarget) -> bytes:
        """读到一行（`\\n` 结尾）。缓冲留着 —— 一次 recv 可能带回不止一行。"""
        with self._lock:
            buffer = self._buffers.get(target.arm, b"")
            sock = self._socks[target.arm]
        while b"\n" not in buffer:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("跟随服务关闭了连接")
            buffer += chunk
        line, _, rest = buffer.partition(b"\n")
        with self._lock:
            self._buffers[target.arm] = rest
        return line

    def _drop_socket(self, arm: str) -> None:
        with self._lock:
            sock = self._socks.pop(arm, None)
            self._buffers.pop(arm, None)
        if sock is not None:
            _quiet_close(sock)

    def _broadcast(self, event: dict) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for cb in listeners:
            try:
                cb(event)
            except Exception:  # noqa: BLE001 - a broken listener is not the poller's
                log.warning("follow 事件监听器抛出异常 (已忽略)", exc_info=True)


# ── 载荷归一化（形状照 `status_msgs.ArmStatus`） ────────────────────────────

_JOINT_FIELDS = ("q", "dq", "tau", "t_mos", "t_coil", "err")


def _arm_payload(target: _ArmTarget, reply: Optional[dict], *, error: Optional[str]) -> dict:
    if reply is None:
        return {
            "device": target.device, "connected": False, "ok": False, "source": "",
            "state": None, "mode": None, "enabled": None, "following": None,
            "flags": [], "fault": [], "joint_fault": None, "q": None,
            "target": None, "anchor": None, "cmd_q": None, "joints": None,
            "age_ms": 0.0, "error": error or "跟随服务不可达",
        }
    # `port` 是 follow 打开的那个串口 —— **它自己报的物理身份**（回包没带就退回清单里的）。
    device = reply.get("port") or target.device
    return {
        "device": str(device), "connected": True, "ok": bool(reply.get("ok", True)),
        "source": _arm_source(reply),
        "state": reply.get("state"), "mode": reply.get("mode"),
        "enabled": reply.get("enabled"), "following": reply.get("following"),
        "flags": list(reply.get("flags") or []),
        "fault": list(reply.get("fault") or []),
        "joint_fault": reply.get("joint_fault"),
        "q": reply.get("q"), "target": reply.get("target"),
        "anchor": reply.get("anchor"), "cmd_q": reply.get("cmd_q"),
        "joints": _joints_object(reply.get("joints")),
        "age_ms": 0.0, "error": reply.get("error"),
    }


def _joints_object(raw: Any) -> Optional[dict]:
    """`joints` 的两种形状：stm32 版回**每关节一个 6 元组**，上游汇总是**六个并行数组**。

    统一成后者（前端与上游那份同形）。已经是对象的原样放行。
    """
    if isinstance(raw, dict):
        return {key: list(raw.get(key) or []) for key in _JOINT_FIELDS}
    if not isinstance(raw, (list, tuple)):
        return None
    columns: dict[str, list[Any]] = {key: [] for key in _JOINT_FIELDS}
    for entry in raw:
        if not isinstance(entry, (list, tuple)) or len(entry) < len(_JOINT_FIELDS):
            return None
        for key, value in zip(_JOINT_FIELDS, entry):
            columns[key].append(value)
    return columns


def _arm_source(reply: dict) -> str:
    """哪一版 follow：stm32 版回 `flags`，sdk 版回 `fault`（上游同一套判据）。"""
    if "flags" in reply:
        return "stm32"
    if "fault" in reply:
        return "sdk"
    return ""


def _quiet_close(sock: socket.socket) -> None:
    try:
        sock.close()
    except OSError:
        pass
