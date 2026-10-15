"""VR 通道：把 `litearm-vr-bridge` 的 zenoh 那条边接进上位机（与 `gripper/` 同形）。

臂与夹爪之外的第二、第三条设备通道：各推各的帧（`vr_conn` / `vr_state` / `vr_arm` / `vr_grip`）、
各走各的命令前缀（`vr.`）。
"""

from .session import ACTIONS, DEFAULT_ENDPOINT, STATUS_KEYEXPR, VrSession

__all__ = ["VrSession", "DEFAULT_ENDPOINT", "ACTIONS", "STATUS_KEYEXPR"]
