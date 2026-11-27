---
title: "LiteArm VR Studio"
subtitle: "User Manual"
title-meta: "LiteArm VR Studio User Manual"
author: "NEXFORM ROBOTICS"
version: "v2.0"
date: "November 27, 2026"
---

# LiteArm VR Studio User Manual

## 1. Introduction and connection

> [!IMPORTANT]
> The robotic arm moves with inertia and force. Before starting teleoperation, ensure the working envelope is clear of personnel and free of obstacles, and keep the physical emergency stop within reach.

### 1.1 What this console is

LiteArm VR Studio in this build is the **VR teleoperation console**. It does not drive the arm in the control loop: controller frames go from the headset through `litearm-vr-bridge` into the teleoperation service (metavr), which solves IK and commands the follow service; the follow service drives the arm's STM32 controller. The console watches that whole link and gives you the switches:

```
Pico headset ──Wi-Fi──> litearm-vr-bridge :8765
                             │  zenoh
                             ├──> metavr teleop (IK) ──> follow service ──> STM32 ──CAN──> motors
                             └──> this console (status, start/stop, e-stop, configuration)
```

Two consequences worth remembering:

- **The console is not in the motion path.** Closing the console does not stop a running teleoperation link; use **Stop Teleop** or the physical emergency stop.
- **The arm's serial port is exclusive.** The console opens it to read state (motor loads, ports). Pressing **Start Teleop** hands the port to the follow service; the console gives it back when teleoperation stops.

The console is one local program (`litearm-vr-studio-daemon`) plus one embedded window. The daemon binds `127.0.0.1` only; the UI talks to it over loopback, and the daemon talks to the bridge over zenoh.

### 1.2 What must be running

| Piece | Where | Default |
| :--- | :--- | :--- |
| `litearm-vr-bridge` | The control machine | Status page `ws://<control-host>:8765`, headset connects here |
| Teleop + follow service | Started by the bridge's managed processes | — |
| `litearm-vr-studio-daemon` | The control machine | zenoh endpoint `tcp/127.0.0.1:7447` |
| Headset | Wi-Fi, pointing at the bridge | `ws://<control-host>:8765` |

The daemon reaches the bridge at `tcp/127.0.0.1:7447` by default. If the bridge is elsewhere, start the daemon with `--vr-endpoint tcp/<host>:<port>` — the endpoint is machine configuration, not something the page asks the operator for.

### 1.3 Install and run

Download the executable for your platform and verify it against the `.sha256` published next to it:

| Platform | File | How to run |
| :--- | :--- | :--- |
| Ubuntu / Debian | `litearm-vr-studio-<version>_amd64.deb` | `sudo apt install ./litearm-vr-studio-<version>_amd64.deb` |
| Windows | `litearm-vr-studio-<version>-windows-amd64.exe` | Double-click |
| Other Linux | `litearm-vr-studio-<version>-linux-amd64` | `chmod +x`, then run |

The `.deb` also installs a desktop entry and the udev rule that lets the logged-in user open the arm's serial port. The standalone Linux file needs glibc 2.35 or newer (Ubuntu 22.04+, Debian 12+). [INSTALL.md](INSTALL.md) has the download commands, checksum verification, serial-port permissions and where settings live.

The program is self-contained: no Python install and no browser — it opens its own embedded window. **Closing that window quits the program** (the serial port is released); reloading the page does not quit. It prints the address it listens on, `http://127.0.0.1:49321/` by default; if that port is taken it picks the next free one and prints it.

> [!IMPORTANT]
> **On Linux the current user must be allowed to open the serial port** (normally the `dialout` group), otherwise the console opens but cannot read the arm:
> ```bash
> sudo usermod -aG dialout "$USER"   # takes effect after you log in again
> ```

### 1.4 Activation

This build ships **only the VR console**: the activation form that lived on the removed Settings page is not part of it. Activate the arm with the full-featured LiteArm Studio build before delivery, or ask your supplier to activate it.

If the firmware refuses to enable the arm because it is not activated, the console shows an activation error in the status messages. The request itself has to be submitted from that full-featured build (or by the supplier); nothing in this console can submit it.

---

## 2. The VR console

The page is three columns: motor load on the left, 3D arm preview in the centre, and three cards stacked on the right — **Teleop Control**, **VR Link**, and **Arm Mapping**. The top bar carries the page title, a badge that appears only while the console side is driving the arm, and the **Link config** button.

### 2.1 Arm mapping

Tells the bridge which serial port belongs to which arm, and which CAN port holds the gripper. Getting this wrong does not raise an error — the left controller's solution simply goes to the right arm.

- One row per arm (left / right) plus the gripper; choose the port from the list (or type it if the list is unavailable) and press **Save to the bridge**.
- The card reports where each value came from: **Confirmed** (recorded on the bridge), **Install default**, or **Not reported**.
- A mismatch banner appears if the follow server actually opened a different device than the one selected.
- **Ports are frozen while teleoperation runs** — the port is part of the managed command line at launch. Stop teleoperation before changing it.

### 2.2 Teleop control

| Control | What it does |
| :--- | :--- |
| **E-STOP** | Sends `stop` to the follow service and stops forwarding controller frames. The most-used control in an emergency. |
| **▶ Start Teleop** | Hands the arm's serial port to the bridge, starts the managed upstream processes and begins forwarding. Disabled while the bridge is offline or no headset is connected. |
| **■ Stop Teleop** | Stops forwarding and stops the follow service; the console takes the serial port back. |
| **In Control** | Who currently commands the arm: **VR headset**, **Console**, **Nobody**, or **Both** (a conflict — stop one side immediately). |

The console side (studio → `litearm-server:7449`) and the VR side are **mutually exclusive**: the same motors cannot be commanded by two controllers. While the console side is executing a motion, following, dragging in zero gravity or running impedance, Start Teleop stays disabled and the card says which activity is blocking it.

After a safe hold or a stop, following does not resume by itself: **release and press the grip again** on the headset.

### 2.3 VR link

The state of the whole chain, with one data source line naming the bridge:

| State | Meaning |
| :--- | :--- |
| Connected · Idle | Bridge reachable, nothing following |
| Following | Frames are being forwarded to the arm |
| Connected · Holding | Frames arriving, but the arm is holding its pose |
| Safe Hold | No frames for longer than the fallback window; the bridge latched a hold |

Statistics: pose rate (Hz), wireless latency (shown as the increase over the window's minimum — the headset clock is not comparable with the host, so this is not an absolute latency), time since last frame, frames forwarded, bridge forward cost, dropped and blocked counts.

Diagnostics list each hop in order — headset, bridge, IK, follow, arm — with `connected` / `not connected` and the live number that belongs to it.

Alert banners appear above the statistics when something is wrong:

- **Follow server faults** — one line per faulted joint or flag (`J3: 5`, `FB_STALE`, …);
- **Follow server error** — the follow service's own error message;
- **Safe hold engaged** — with the frame gap that triggered it; following resumes only after a fresh grip press;
- **Fallback is off** — when the bridge runs with `FALLBACK_ENABLED=0`: no automatic hold at all;
- **Version mismatch** — the bridge reports a version other than the one this page was written against; some fields may already be read wrongly. Bring one side up to date.

### 2.4 Motor load

Left arm on top, right arm below, one bar per motor with the current load, the session peak, and MOS / coil temperatures. A gripper row appears when the bridge reports one. Sections keep their place when an arm is missing or reports no data, so the layout does not jump with the link. Rated values come from the arm's own state; `rated value unavailable` means the firmware did not report them.

### 2.5 Arm preview

A 3D view of the arm driven by the live joint angles. **Axes**, **Focus** and **Top View** are on the title row. The source line says whether the pose is **Real** or **Simulated**.

With a single arm, the preview renders the rig's own URDF while the joint angles come from metavr's model; the two differ in joint origins, axes and limits, so the picture does not match what metavr believes and the arm can look askew. That is a known deviation, not bad data. With two arms the preview is the rig model (two side-mounted arms on one column).

### 2.6 Link configuration

The **Link config** button opens the bridge's editable settings, grouped into **Machine and mounting**, **Following**, **Bridge service**, **Upstream processes**, **Safety**, and per-arm sections (left / right):

- Machine: real arm vs simulation, driving hand, viewer, upright vs side mount, hand and gripper enable and addresses, single vs dual arm;
- Following: link mode, control law, serial port, dry run;
- Arms: device, gripper, host and port per arm;
- Bridge: log level, log format, log file, record file location;
- Upstream: managed processes on or off.

Each row says where its value comes from (`set here`, `config.toml`, `default`), whether it is writable, and whether it takes effect **now** or **needs restart**. Saved values are stored as overrides on the bridge; the dialog shows the file path. Read-only rows cannot be edited, and the bridge's own refusal (in its words) is shown instead of a generic error.

Editing is disabled while teleoperation or the upstream processes are running: managed command lines are fixed at launch. Stop teleoperation first.

---

## 3. Operating procedure

1. **Start the bridge** on the control machine and confirm its status page is reachable; the headset connects to `ws://<control-host>:8765`.
2. **Start the console.** It connects to the bridge over zenoh (`tcp/127.0.0.1:7447` by default; `--vr-endpoint` otherwise).
3. **Check Arm Mapping.** Pick the port for each arm and the gripper and save to the bridge. Do this before starting teleoperation.
4. **Check the VR Link card.** Headset `connected`, bridge `connected`, no version-mismatch banner, no fault banner.
5. **Press ▶ Start Teleop.** The console hands the serial port to the bridge and starts the upstream processes.
6. **On the headset, press the grip** to anchor and start following; release to hold.
7. **To stop:** **■ Stop Teleop** for a normal stop, **E-STOP** in an emergency. After a stop or a safe hold, press the grip again (release → press) to resume.
8. **When finished,** stop teleoperation and close the window; the serial port is released and the arm is de-energised.

---

## 4. Safety rules and troubleshooting

### 4.1 Safety rules

1. Clear the working envelope before starting teleoperation, and keep the physical emergency stop within reach;
2. **E-STOP** in the console sends a stop to the follow service and stops forwarding — it is not a substitute for cutting power in a critical situation;
3. The console is not in the motion path: closing the window does **not** stop a running teleoperation link;
4. Do not change arm mapping or link configuration while teleoperation is running;
5. Do not let the console side and the VR side drive the arm at the same time; the **Both** ownership state means exactly that conflict.

### 4.2 Troubleshooting

| Symptom | Cause | What to do |
| :--- | :--- | :--- |
| VR Link says the bridge is not connected | Bridge not running, or the daemon's endpoint is wrong | Start `litearm-vr-bridge`; if it is not on this machine, start the daemon with `--vr-endpoint` |
| Headset shows `not connected` | Headset not joined to the bridge's address, or Wi-Fi dropped | Check the headset's bridge address (`ws://<control-host>:8765`) and the network |
| Version mismatch banner | Bridge version differs from the one this page was written against | Update the bridge or the console so both match; until then treat empty fields as suspect rather than as zeros |
| Start Teleop is greyed out | Bridge offline, no headset, or the console side is driving the arm | Read the card's banner: it names the blocking activity. Stop the console-side motion first |
| Safe Hold keeps triggering | No frames within the fallback window | Check the headset link and Wi-Fi; press the grip again (release → press) to resume following |
| The arm does not move although Following shows | Follow service fault or the arm is not enabled | Read the fault banner; clear the fault on the follow side, then press the grip again |
| "This arm is not activated" when starting | The firmware refuses to enable an unlicensed arm | Activate the arm with the full-featured LiteArm Studio build or through your supplier; this console cannot submit the form |
| Arm mapping keeps reverting | A value was edited while teleoperation was running | Stop teleoperation, edit, then save again |
