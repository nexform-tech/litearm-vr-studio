---
title: "LiteArm"
subtitle: "Quickstart Guide"
title-meta: "LiteArm Quickstart Guide"
author: "NEXFORM ROBOTICS"
version: "v2.1"
date: "October 6, 2026"
---

# LiteArm Quickstart Guide

## 1. Architecture & Requirements

LiteArm VR Studio is a local Python program plus a browser UI. The program owns the USB serial link to the arm; the UI is served by that program and talks to it over a loopback WebSocket. There is no server and no IP address to configure.

This build is the **VR teleoperation console**. Controller frames do not pass through it: the headset sends them to `litearm-vr-bridge`, the bridge hands them to the teleoperation service (metavr, IK), and that service drives the follow service and the arm. The console reads the whole chain from the bridge over zenoh and provides start / stop / e-stop and the bridge configuration.

```
browser window (React UI, served by the daemon)
   │  HTTP  → static assets, /api/health
   │  WS    → state push (down) / commands (up)
   ▼
litearm-vr-studio-daemon  (Python, 127.0.0.1 only)
   ├── USB CDC ──> STM32 (serial held for state; handed over during teleoperation)
   └── zenoh ──> litearm-vr-bridge ◀── Wi-Fi ── Pico headset
                     │  zenoh
                     └──> metavr teleop (IK) ──> follow service ──> STM32 ──CAN──> motors
```

### Requirements

- Control host: Linux or Windows with a free USB port; Python 3.10+
- Arm controller powered on and connected over USB (USB CDC, VID:PID `1d50:606f`)
- `litearm-vr-bridge` running on the control host (the console is a client of the bridge for the VR link)
- A Pico headset joined to the bridge at `ws://<control-host>:8765`
- Node.js 20+ and pnpm only if you are building the UI yourself

---

## 2. Installation

There are two routes. To run a released build, download the one-file executable and follow
[INSTALL.md](INSTALL.md) — no Python, no pnpm and no checkout. The commands below build from
source, which is what development needs.

The two SDKs are not published on PyPI — they are git submodules of this repository under
`sdk/`, pinned by tag — so clone with the submodules and install them in one step:

```bash
git clone --recurse-submodules https://github.com/nexform-tech/litearm-vr-studio.git
cd litearm-studio

make sdk                           # fetch + install the pinned SDK submodules
pip install -e "daemon[test,ui]"
sudo apt install python3-gi gir1.2-webkit2-4.1   # Linux only: the window's renderer
```

The `ui` extra is `pywebview`, the window itself. On Linux it still needs a renderer, and
the small one is the system's WebKitGTK (`python3-gi` plus `gir1.2-webkit2-4.1`). Do not
reach for `daemon[ui-qt]` unless those packages are unavailable: it bundles a Chromium and
takes the `.deb` from about 28 MB to about 250 MB. Leave the window out entirely only if you
always run headless with `--no-open`; without a renderer the program exits with an error
rather than opening a window.

Build the UI that the daemon will serve (skip only if `dist/` already exists):

```bash
pnpm install && pnpm build
```

The first build downloads the robot model (about 60 MiB, ten files, ~30 s) from
[litearm-description](https://github.com/nexform-tech/litearm-description) — it is not in this
repository, and `pnpm build` fetches it before it compiles anything. Later builds reuse it and
touch the network only to check whether upstream moved. **If that download fails**, the 3D
panel is what breaks — see the troubleshooting entry at the end of this document.

---

## 3. Running

```bash
# Offline: a complete session on the SDK's fake transport — no hardware required
litearm-vr-studio-daemon --fake

# Real arm: auto-discovers the USB CDC device
litearm-vr-studio-daemon

# Explicit port, custom HTTP port, no window
litearm-vr-studio-daemon --port /dev/ttyACM1 --http-port 9000 --no-open

# Bridge on another machine: point the daemon at its zenoh endpoint
litearm-vr-studio-daemon --vr-endpoint tcp/192.168.31.139:7447
```

The daemon prints the address it actually bound to (default `http://127.0.0.1:49321/`; if the port is busy it increments and prints the new one) and opens its own embedded application window. No browser needs to be installed. Closing that window quits the program.

| | |
| --- | --- |
| Console | `http://127.0.0.1:<port>/` |
| WebSocket | `ws://127.0.0.1:<port>/ws` |
| Health check | `http://127.0.0.1:<port>/api/health` |

> [!IMPORTANT]
> The daemon binds `127.0.0.1` only. There is no option to expose it on a LAN — an interface that can drive an arm is not something to publish.

---

## 4. First run: VR teleoperation

> [!WARNING]
> Clear the working envelope of people and obstacles, and keep the physical emergency stop within reach before starting teleoperation. The console's **E-STOP** sends a stop to the follow service; it does not cut power.

### Step 1 — Start the bridge

Start `litearm-vr-bridge` on the control host and open its status page. The headset connects to `ws://<control-host>:8765`; the console reaches the bridge over zenoh at `tcp/127.0.0.1:7447` by default.

### Step 2 — Start the console and check the link

1. Start the daemon (it opens its window for you).
2. The right column shows **VR Link**; the data source line names the bridge. Headset and bridge should both read `connected`.
3. No **Version mismatch** banner: the bridge version has to match the one this page is written against.

### Step 3 — Map the arms

In **Arm Mapping**, pick the serial port for each arm and the gripper, then press **Save to the bridge**. This must be done before teleoperation starts: the port is frozen into the managed command line at launch.

### Step 4 — Start teleoperation

1. Press **▶ Start Teleop**. The console hands the arm's serial port to the bridge and starts the upstream processes.
2. On the headset, **press the grip** to anchor and start following; release it to hold.
3. Watch **VR Link**: the state becomes **Following**, and the statistics (pose rate, frames forwarded, dropped) move.

### Step 5 — Stop

**■ Stop Teleop** for a normal stop, **E-STOP** in an emergency (it stops the follow service and stops forwarding). After a stop or a safe hold, release and press the grip again to resume. Closing the window does **not** stop a running teleoperation link.

### Activation

This build ships only the VR console — the activation form is not part of it. Activate the arm with the full-featured LiteArm Studio build or through your supplier before delivery; if the firmware refuses to enable an unactivated arm, the console reports it but cannot submit the form.

---

## 5. Troubleshooting

### The daemon starts but reports no module named `litearm`

`litearm-python` is not on PyPI — it ships as a submodule of this repository. Run `make sdk`
(or `git submodule update --init --recursive && pip install ./sdk/litearm-python`).

### No device found / “未发现 STM32 CDC 设备”

- Check the USB cable and that the controller is powered.
- Verify the device enumerates with VID:PID `1d50:606f`.
- If it shows up under a different path, pass it explicitly: `litearm-vr-studio-daemon --port /dev/ttyACM1`.
- On Linux, make sure your user can open the serial device (`dialout` group).

### VR Link says the bridge is not connected

- The bridge process is not running on the control host, or it is on another machine and the daemon still points at `tcp/127.0.0.1:7447`. Start the bridge, or start the daemon with `--vr-endpoint tcp/<host>:<port>`.
- The bridge and the daemon must both speak zenoh on the same endpoint; a typo in the endpoint shows up here, not as a crash.

### Version mismatch banner in VR Link

The bridge reports a version other than the one this page was written against. Until both sides match, treat empty fields as suspect rather than as zeros: the page degrades quietly, and that is the hardest failure to notice. Update the bridge or the console so the major.minor versions agree.

### "This arm is not activated"

The firmware refuses to enable an unlicensed arm. This build cannot submit the activation form — activate it with the full-featured LiteArm Studio build or through your supplier.

### The 3D panel shows the ground plane and no arm

The model was not fetched. `pnpm build` downloads it from GitHub first (about 60 MiB) and stops
with `[description] error: …` if that fails — so the build usually fails rather than producing a
UI without an arm. If you see the panel empty anyway:

- run `make description` and build again; it prints what it fetched and from where;
- behind a proxy or in a network that cannot reach GitHub, point
  `LITEARM_DESCRIPTION_BASE_URL` (the files) and `LITEARM_DESCRIPTION_GIT_URL` (the tag list) at
  a mirror, or copy a `public/description/` from a machine that has one;
- `pnpm exec vitest run src/description.model.test.ts` says what is wrong with what is on disk.

The panel drawing the ground plane and the base axes with **no arm** is also what a model whose
link names changed looks like (issue #150) — that is the failure the guard test above exists to
catch before it ships.

### The UI loads but never shows state

- Check `http://127.0.0.1:<port>/api/health` — `connected` must be `true`.
- If `conn.status` is `error`, the `conn.error` field carries the reason (device missing, firmware mismatch, transport failure).

### Port 49321 is already in use

The daemon automatically picks the next free port and prints it; read the printed console URL rather than assuming 49321.

### Closing the window quits the program

That is deliberate: the window belongs to the program, so closing it ends the session — the arm is de-energised and the serial port is released. Reloading the page does **not** quit; only closing the window does.

Start the program again and you get a clean session. If an instance is still running (an older version, or the icon was clicked twice), starting the program **raises that instance's window** instead of starting a second program.

### The window says the port cannot be opened but the arm is connected

The program that holds the arm is still running and you started a second one by naming a specific session (`--port`, `--fake`, `--can-channel`, …). Check `http://127.0.0.1:49321/api/health` for the running one, close the second window, and start the program again without those options to attach to the session that is already up.
