import type { VrBridgeSnapshot } from '../vrTypes'

/**
 * litearm-vr-bridge 的真实快照固件。
 *
 * 来源：跑真桥（`PYTHONPATH=src python3 -m litearm_vr_bridge`）+ 忠实对端
 * （上游 ControllerFrameParser 做手柄语义、9001 协议对齐 arm_follow_server），
 * 从 `/ws/status` 原样抓下来的载荷。只有"数值本身"被固定下来（`ts`、`uptime_s`、
 * `version`、`last_ok_age_ms`、`latency_ms`、`last_frame_age_ms`），
 * **`null` 保持 `null`** —— 桥在没有样本时就是这么发的（见 no_headset 固件），
 * 页面对 null 的容忍度必须一起钉住。
 *
 * 四个状态分别是：头显未接入 / 正常跟随 / 无帧兜底 / 停止遥操。
 * 桥端字段增删时，这份固件会先在类型检查上暴露出来。
 *
 * ⚠ **这里没有真机状态**（连接 / 状态 / 故障 / 关节角）。桥从 `4c7a772` 起不再照下游，
 *   它的 `arm` 段只剩**身份与去处**（谁、接在哪、follow 在哪），四个状态里都是同一份
 *   （2026-10-16 从真桥抓的）。臂的连接与故障由上游汇总服务按臂发在 `vr_arm` 上 ——
 *   样例见 `armStatus.ts`。
 *
 *   这条分界必须守住：以前这份固件里躺着老桥的 `arm.connected/state/fault`，而桥早
 *   就不发它们了。页面照着读，于是"跟随服务"那一跳永远显示"未连接"、故障永远显示不
 *   出来 —— 用例却全绿，因为固件和代码错到了一起。**固件要跟着被仿的对端走。**
 *
 * ⚠ 2026-10-16 又栽在同一个坑上：桥在 10-15「上游正名为 teleop」时把 `metavr_connected`
 *   改成了 `teleop_connected`（进程名 `metavr` → `teleop`，日志名同理），而这份固件没跟。
 *   于是链路卡上"逆解服务"那一跳永远显示"未连接"，用例还是全绿。这次一并对齐：桥发什么
 *   名字，固件就写什么名字。
 */

/** no_headset */
export const SNAP_NO_HEADSET: VrBridgeSnapshot = {
  "arm": {
    "side": "left",
    "device": "/dev/serial/by-id/usb-STMicroelectronics_LiteArm_LL-2024-if00",
    "device_source": "config",
    "device_confirmed_at": null,
    "follow": "127.0.0.1:9001",
    "commands": {
      "requests": 0,
      "failures": 0,
      "last_ok_age_ms": null,
      "error": null
    }
  },
  "bridge": {
    "clients": {
      "headset": 0,
      "status": 1
    },
    "forward_cost_last_ms": null,
    "forward_cost_max_ms": null,
    "forward_cost_ms": null,
    "teleop_connected": true,
    "online": true
  },
  "events": [],
  "fallback": {
    "active": false,
    "guard_enabled": true,
    "reason": null
  },
  "headset": {
    "bad_frames": 0,
    "connected": false,
    "following": false,
    "fps": 0.0,
    "frames": 0,
    "frames_blocked": 0,
    "frames_dropped": 0,
    "frames_forwarded": 0,
    "grip": false,
    "last_frame_age_ms": null,
    "last_frame_ts": null,
    "latency_estimated": false,
    "latency_ms": null,
    "online": false,
    "tracked": false
  },
  "link": {
    "enabled": true,
    "fallback_ms": 500.0,
    "forward_enabled": true,
    "rearm_required": false,
    "state": "idle",
    "warn_ms": 200.0
  },
  "owner": "none",
  "processes": {
    "follow_server": "stopped",
    "teleop": "stopped"
  },
  "processes_detail": {
    "follow_server": {
      "command": "python3 /opt/litearm/vr/arm_follow_server_sdk.py --host 127.0.0.1 --tcp-port 9001 --iface can0",
      "exit_code": null,
      "last_error": null,
      "pid": null,
      "starts": 0,
      "status": "stopped",
      "uptime_s": null
    },
    "teleop": {
      "command": "/usr/bin/python3 -c import sys; sys.exit(3)",
      "exit_code": null,
      "last_error": null,
      "pid": null,
      "starts": 0,
      "status": "stopped",
      "uptime_s": null
    }
  }
}

/** following */
export const SNAP_FOLLOWING: VrBridgeSnapshot = {
  "arm": {
    "side": "left",
    "device": "/dev/serial/by-id/usb-STMicroelectronics_LiteArm_LL-2024-if00",
    "device_source": "config",
    "device_confirmed_at": null,
    "follow": "127.0.0.1:9001",
    "commands": {
      "requests": 0,
      "failures": 0,
      "last_ok_age_ms": null,
      "error": null
    }
  },
  "bridge": {
    "clients": {
      "headset": 1,
      "status": 1
    },
    "forward_cost_last_ms": 0.093,
    "forward_cost_max_ms": 0.146,
    "forward_cost_ms": 0.098,
    "teleop_connected": true,
    "online": true
  },
  "events": [],
  "fallback": {
    "active": false,
    "guard_enabled": true,
    "reason": null
  },
  "headset": {
    "bad_frames": 0,
    "connected": true,
    "following": true,
    "fps": 82.5,
    "frames": 57,
    "frames_blocked": 0,
    "frames_dropped": 0,
    "frames_forwarded": 57,
    "grip": true,
    "last_frame_age_ms": 4.2,
    "last_frame_ts": 1789637801598,
    "latency_estimated": false,
    "latency_ms": 12.3,
    "online": true,
    "tracked": true
  },
  "link": {
    "enabled": true,
    "fallback_ms": 500.0,
    "forward_enabled": true,
    "rearm_required": false,
    "state": "following",
    "warn_ms": 200.0
  },
  "owner": "vr",
  "processes": {
    "follow_server": "stopped",
    "teleop": "stopped"
  },
  "processes_detail": {
    "follow_server": {
      "command": "python3 /opt/litearm/vr/arm_follow_server_sdk.py --host 127.0.0.1 --tcp-port 9001 --iface can0",
      "exit_code": null,
      "last_error": null,
      "pid": null,
      "starts": 0,
      "status": "stopped",
      "uptime_s": null
    },
    "teleop": {
      "command": "/usr/bin/python3 -c import sys; sys.exit(3)",
      "exit_code": null,
      "last_error": null,
      "pid": null,
      "starts": 0,
      "status": "stopped",
      "uptime_s": null
    }
  }
}

/** fallback */
export const SNAP_FALLBACK: VrBridgeSnapshot = {
  "arm": {
    "side": "left",
    "device": "/dev/serial/by-id/usb-STMicroelectronics_LiteArm_LL-2024-if00",
    "device_source": "config",
    "device_confirmed_at": null,
    "follow": "127.0.0.1:9001",
    "commands": {
      "requests": 0,
      "failures": 0,
      "last_ok_age_ms": null,
      "error": null
    }
  },
  "bridge": {
    "clients": {
      "headset": 1,
      "status": 1
    },
    "forward_cost_last_ms": 0.08,
    "forward_cost_max_ms": 0.281,
    "forward_cost_ms": 0.104,
    "teleop_connected": true,
    "online": true
  },
  "events": [
    {
      "code": "follow_started",
      "id": 1,
      "level": "info",
      "message": "grip 按下：开始跟随",
      "ts": 1789637801347
    },
    {
      "code": "process_started",
      "data": {
        "log": "logs/teleop.log",
        "pid": 453862,
        "process": "teleop"
      },
      "id": 2,
      "level": "info",
      "message": "进程 teleop 已启动",
      "ts": 1789637804339
    },
    {
      "code": "process_crashed",
      "data": {
        "exit_code": 3,
        "process": "teleop"
      },
      "id": 3,
      "level": "danger",
      "message": "进程 teleop 意外退出（code=3）；本服务不会自动重启它",
      "ts": 1789637804377
    },
    {
      "code": "frame_stall",
      "data": {
        "age_ms": 203.2,
        "warn_ms": 200.0
      },
      "id": 4,
      "level": "warn",
      "message": "203 ms 没有新帧（阈值 200 ms）",
      "ts": 1789637804530
    },
    {
      "code": "fallback_latch",
      "data": {
        "age_ms": 507.3,
        "fallback_ms": 500.0
      },
      "id": 5,
      "level": "danger",
      "message": "超过 500 ms 无新帧：已下发 latch 就地持位",
      "ts": 1789637804834
    },
    {
      "code": "latch_done",
      "data": {
        "action": "latch",
        "ok": true,
        "reason": "no_frame>500ms",
        "reply": {
          "cmd": "latch",
          "ok": true
        }
      },
      "id": 6,
      "level": "info",
      "message": "就地持位指令已下发（no_frame>500ms）",
      "ts": 1789637804835
    }
  ],
  "fallback": {
    "active": true,
    "guard_enabled": true,
    "reason": "no_frame>500ms"
  },
  "headset": {
    "bad_frames": 0,
    "connected": true,
    "following": false,
    "fps": 82.9,
    "frames": 282,
    "frames_blocked": 0,
    "frames_dropped": 0,
    "frames_forwarded": 282,
    "grip": true,
    "last_frame_age_ms": 512.0,
    "last_frame_ts": 1789637804326,
    "latency_estimated": false,
    "latency_ms": 12.3,
    "online": false,
    "tracked": true
  },
  "link": {
    "enabled": true,
    "fallback_ms": 500.0,
    "forward_enabled": true,
    "rearm_required": false,
    "state": "fallback",
    "warn_ms": 200.0
  },
  "owner": "vr",
  "processes": {
    "follow_server": "stopped",
    "teleop": "crashed"
  },
  "processes_detail": {
    "follow_server": {
      "command": "python3 /opt/litearm/vr/arm_follow_server_sdk.py --host 127.0.0.1 --tcp-port 9001 --iface can0",
      "exit_code": null,
      "last_error": null,
      "pid": null,
      "starts": 0,
      "status": "stopped",
      "uptime_s": null
    },
    "teleop": {
      "command": "/usr/bin/python3 -c import sys; sys.exit(3)",
      "exit_code": 3,
      "last_error": "退出码 3",
      "pid": null,
      "starts": 1,
      "status": "crashed",
      "uptime_s": 0.6
    }
  }
}

/** stopped */
export const SNAP_STOPPED: VrBridgeSnapshot = {
  "arm": {
    "side": "left",
    "device": "/dev/serial/by-id/usb-STMicroelectronics_LiteArm_LL-2024-if00",
    "device_source": "config",
    "device_confirmed_at": null,
    "follow": "127.0.0.1:9001",
    "commands": {
      "requests": 0,
      "failures": 0,
      "last_ok_age_ms": null,
      "error": null
    }
  },
  "bridge": {
    "clients": {
      "headset": 1,
      "status": 1
    },
    "forward_cost_last_ms": 0.098,
    "forward_cost_max_ms": 0.325,
    "forward_cost_ms": 0.107,
    "teleop_connected": true,
    "online": true
  },
  "events": [
    {
      "code": "follow_started",
      "id": 1,
      "level": "info",
      "message": "grip 按下：开始跟随",
      "ts": 1789637801347
    },
    {
      "code": "process_started",
      "data": {
        "log": "logs/teleop.log",
        "pid": 453862,
        "process": "teleop"
      },
      "id": 2,
      "level": "info",
      "message": "进程 teleop 已启动",
      "ts": 1789637804339
    },
    {
      "code": "process_crashed",
      "data": {
        "exit_code": 3,
        "process": "teleop"
      },
      "id": 3,
      "level": "danger",
      "message": "进程 teleop 意外退出（code=3）；本服务不会自动重启它",
      "ts": 1789637804377
    },
    {
      "code": "frame_stall",
      "data": {
        "age_ms": 203.2,
        "warn_ms": 200.0
      },
      "id": 4,
      "level": "warn",
      "message": "203 ms 没有新帧（阈值 200 ms）",
      "ts": 1789637804530
    },
    {
      "code": "fallback_latch",
      "data": {
        "age_ms": 507.3,
        "fallback_ms": 500.0
      },
      "id": 5,
      "level": "danger",
      "message": "超过 500 ms 无新帧：已下发 latch 就地持位",
      "ts": 1789637804834
    },
    {
      "code": "latch_done",
      "data": {
        "action": "latch",
        "ok": true,
        "reason": "no_frame>500ms",
        "reply": {
          "cmd": "latch",
          "ok": true
        }
      },
      "id": 6,
      "level": "info",
      "message": "就地持位指令已下发（no_frame>500ms）",
      "ts": 1789637804835
    },
    {
      "code": "frames_recovered",
      "id": 7,
      "level": "info",
      "message": "帧流已恢复（最长 559 ms 无帧）",
      "ts": 1789637804927
    },
    {
      "code": "fallback_cleared",
      "id": 8,
      "level": "warn",
      "message": "帧流恢复；机械臂保持就地持位，需重新按 grip 才能继续跟随",
      "ts": 1789637804927
    },
    {
      "code": "teleop_stopped",
      "id": 9,
      "level": "info",
      "message": "已停止 VR 遥操：转发已关闭，并已请求就地持位",
      "ts": 1789637805730
    },
    {
      "code": "latch_done",
      "data": {
        "action": "latch",
        "ok": true,
        "reason": "teleop.stop",
        "reply": {
          "cmd": "latch",
          "ok": true
        }
      },
      "id": 10,
      "level": "info",
      "message": "就地持位指令已下发（teleop.stop）",
      "ts": 1789637805731
    }
  ],
  "fallback": {
    "active": false,
    "guard_enabled": true,
    "reason": null
  },
  "headset": {
    "bad_frames": 0,
    "connected": true,
    "following": false,
    "fps": 83.2,
    "frames": 375,
    "frames_blocked": 26,
    "frames_dropped": 0,
    "frames_forwarded": 349,
    "grip": true,
    "last_frame_age_ms": 4.2,
    "last_frame_ts": 1789637806034,
    "latency_estimated": false,
    "latency_ms": 12.3,
    "online": true,
    "tracked": true
  },
  "link": {
    "enabled": false,
    "fallback_ms": 500.0,
    "forward_enabled": false,
    "rearm_required": true,
    "state": "latched",
    "warn_ms": 200.0
  },
  "owner": "none",
  "processes": {
    "follow_server": "stopped",
    "teleop": "crashed"
  },
  "processes_detail": {
    "follow_server": {
      "command": "python3 /opt/litearm/vr/arm_follow_server_sdk.py --host 127.0.0.1 --tcp-port 9001 --iface can0",
      "exit_code": null,
      "last_error": null,
      "pid": null,
      "starts": 0,
      "status": "stopped",
      "uptime_s": null
    },
    "teleop": {
      "command": "/usr/bin/python3 -c import sys; sys.exit(3)",
      "exit_code": 3,
      "last_error": "退出码 3",
      "pid": null,
      "starts": 1,
      "status": "crashed",
      "uptime_s": 1.7
    }
  }
}
