---
title: "LiteArm"
subtitle: "快速上手指南"
title-meta: "LiteArm 快速上手指南"
author: "NEXFORM 新元体"
version: "v2.1"
date: "2026 年 10 月 6 日"
---

# LiteArm 快速上手指南

## 1. 系统架构与环境要求

LiteArm VR Studio 是「本地 Python 程序 + 浏览器界面」：程序独占到机械臂的 USB 串口，界面由该程序托管，并通过本机回环上的 WebSocket 与它通信。**没有 server，也没有要填的 IP。**

本版本是 **VR 遥操控制台**。手柄帧不经过它：头显把帧发给 `litearm-vr-bridge`，桥交给遥操服务（metavr，解 IK），再由跟随服务驱动机械臂。上位机通过 zenoh 从桥读取整条链路的状态，并提供起停、急停与桥的配置。

```
浏览器窗口 (React UI，由本地程序托管)
   │  HTTP  → 静态资源、/api/health
   │  WS    → 状态推送(下行) / 命令(上行)
   ▼
litearm-vr-studio-daemon  (Python，只监听 127.0.0.1)
   ├── USB CDC ──> STM32（平时持有串口读状态；遥操时交给桥）
   └── zenoh ──> litearm-vr-bridge ◀── Wi-Fi ── Pico 头显
                     │  zenoh
                     └──> metavr 遥操（IK）──> 跟随服务 ──> STM32 ──CAN──>  电机
```

### 环境要求

- 控制主机：Linux 或 Windows，有一个空闲 USB 口；Python 3.10+
- 机械臂控制器已上电并通过 USB 连接（USB CDC，VID:PID `1d50:606f`）
- 控制主机上已运行 `litearm-vr-bridge`（上位机的 VR 链路是它的客户端）
- Pico 头显已连到桥的 `ws://<控制主机>:8765`
- 只有自己构建界面时才需要 Node.js 20+ 与 pnpm

---

## 2. 安装

有两条路。只想运行发布版，就下载单文件可执行程序并照着 [INSTALL_ZH.md](INSTALL_ZH.md) 做 —— 不需要
Python、不需要 pnpm、也不需要克隆仓库。下面的命令是源码构建，开发时才需要。

两个 SDK 都不在 PyPI 上 —— 它们是本仓 `sdk/` 下的 git submodule，版本由 tag 钉住 ——
所以把 submodule 一起克隆下来，再一条命令装好：

```bash
git clone --recurse-submodules https://github.com/nexform-tech/litearm-vr-studio.git
cd litearm-studio

make sdk                           # 取回并安装钉住版本的 SDK submodule
pip install -e "daemon[test,ui]"
sudo apt install python3-gi gir1.2-webkit2-4.1   # 仅 Linux：窗口的渲染内核
```

`ui` 这个 extra 就是 `pywebview`，窗口本身。Linux 上它还需要一个渲染内核，小的那个是系统的 WebKitGTK（`python3-gi` + `gir1.2-webkit2-4.1`）。**不要**顺手换成 `daemon[ui-qt]`：它自带一个 Chromium，会把 `.deb` 从约 28 MB 撑到约 250 MB。只有当你永远用 `--no-open` 无界面运行时才可以把窗口整个省掉；没有渲染内核时程序会直接报错退出，而不是开一个窗口。

构建本地程序要托管的界面（`dist/` 已存在可跳过）：

```bash
pnpm install && pnpm build
```

首次构建会先从
[litearm-description](https://github.com/nexform-tech/litearm-description) 下载机器人模型
（约 60 MiB、十个文件、国内网络约 30 秒）—— 它不在本仓，`pnpm build` 在编译任何东西之前
先取它。之后的构建复用本地副本，只在检查上游有没有更新时联网。**这一步失败时坏的是 3D
面板**，见本文末尾的常见问题。

---

## 3. 启动

```bash
# 离线：用 SDK 的假传输跑完整会话，不需要任何硬件
litearm-vr-studio-daemon --fake

# 真机：自动发现 USB CDC 设备
litearm-vr-studio-daemon

# 指定串口 / 端口 / 不自动开窗口
litearm-vr-studio-daemon --port /dev/ttyACM1 --http-port 9000 --no-open

# 桥在另一台机器：把本地程序指向它的 zenoh 端点
litearm-vr-studio-daemon --vr-endpoint tcp/192.168.31.139:7447
```

启动后会打印实际监听的地址（默认 `http://127.0.0.1:49321/`；被占用会自动换并打印新端口），并打开**自己的嵌入式应用窗口**——机器上不需要装任何浏览器。关掉那个窗口就是退出程序。

| | |
| --- | --- |
| 控制台 | `http://127.0.0.1:<port>/` |
| WebSocket | `ws://127.0.0.1:<port>/ws` |
| 健康检查 | `http://127.0.0.1:<port>/api/health` |

> [!IMPORTANT]
> 本地程序**只监听 `127.0.0.1`**，没有开给局域网的开关 —— 一个能驱动机械臂的接口不该被发布出去。

---

## 4. 首次运行：VR 遥操

> [!WARNING]
> 开始遥操前请清空工作范围，并让物理急停处在可及范围。控制台上的 **急停** 会向跟随服务下发停止，但它不会切断电源。

### 第 1 步 —— 启动桥

在控制主机上启动 `litearm-vr-bridge` 并确认状态页可达。头显连 `ws://<控制主机>:8765`；上位机默认通过 zenoh 连本机的 `tcp/127.0.0.1:7447`。

### 第 2 步 —— 启动上位机并检查链路

1. 启动本地程序（它会替你打开窗口）。
2. 右列 **VR 链路** 卡的数据源一行应写明桥；头显与桥都应为「已连接」。
3. 不应出现 **版本不匹配** 横幅：桥的版本必须与本页面所写的契约一致。

### 第 3 步 —— 臂映射

在 **臂映射** 卡里为每条臂和夹爪选好串口，按 **保存到桥**。这一步必须在开始遥操之前完成：端口在启动时就写进受管命令行了。

### 第 4 步 —— 开始遥操

1. 按 **▶ 开始遥操**：上位机把机械臂串口交给桥，并拉起上游进程。
2. 在头显上 **按下 grip** 锚定并开始跟随；松开即持位。
3. 盯住 **VR 链路**：状态应变为 **跟随中**，统计项（姿态帧率、转发帧数、丢弃）应有变化。

### 第 5 步 —— 停止

正常停止按 **■ 停止遥操**，紧急情况按 **急停**（它会停止跟随服务并停止转发）。停止或安全持位后，松开再按 grip 才能恢复。**关闭窗口不会停止正在运行的遥操链路。**

### 激活

本版本只带 VR 控制台，不含激活表单。请在交付前用全功能版 LiteArm Studio 或由供方完成激活；固件拒绝使能未激活的机械臂时，控制台会给出提示，但无法提交激活。

---

## 5. 常见问题

### 启动报找不到 `litearm` 模块

`litearm-python` 不在 PyPI 上，它是本仓的 submodule：跑 `make sdk`（或
`git submodule update --init --recursive && pip install ./sdk/litearm-python`）即可。

### 提示「未发现 STM32 CDC 设备」

- 检查 USB 线缆与控制器供电。
- 确认设备以 VID:PID `1d50:606f` 枚举。
- 若它出现在别的设备路径下，显式指定：`litearm-vr-studio-daemon --port /dev/ttyACM1`。
- Linux 下确认当前用户有权限打开串口设备（`dialout` 组）。

### 3D 面板只有地面，没有机械臂

模型没取回来。`pnpm build` 会先从 GitHub 下载它（约 60 MiB），失败时以
`[description] error: …` 中止 —— 所以通常是构建失败，而不是构建出一个没有臂的界面。仍然
看到空面板时：

- 跑一次 `make description` 再重新构建，它会打印取了什么、从哪儿取的；
- 在连不上 GitHub 的代理或内网里，把 `LITEARM_DESCRIPTION_BASE_URL`（文件）与
  `LITEARM_DESCRIPTION_GIT_URL`（tag 列表）指向镜像，或把有网的机器上的
  `public/description/` 拷过来；
- `pnpm exec vitest run src/description.model.test.ts` 会指出磁盘上那份模型哪里不对。

面板只画出地面与底座坐标轴、**没有臂**，也正是"模型的 link 名变了"的样子（issue #150）
—— 上面那条守卫测试就是为了在发布之前拦住它。

### VR 链路显示桥未连接

- 桥进程没跑，或桥在别的机器上而本地程序还指向 `tcp/127.0.0.1:7447`。启动桥，或用 `--vr-endpoint tcp/<host>:<port>` 启动本地程序。
- 桥与本地程序必须在同一 zenoh 端点上；端点写错就表现为这里连不上，而不是崩溃。

### VR 链路出现「版本不匹配」

桥上报的版本与本页面所写的契约不同。在两侧一致之前，把空字段当成可疑值而不是 0：页面会安静地少显示几样，那是最难发现的坏法。把桥或上位机升级到 major.minor 一致。

### 提示「这台机械臂未激活」

固件拒绝使能未授权的机械臂。本版本无法提交激活表单 —— 请用全功能版 LiteArm Studio 或通过供方完成激活。

### 界面能打开但一直没有状态

- 访问 `http://127.0.0.1:<port>/api/health`，`connected` 必须为 `true`。
- 若 `conn.status` 是 `error`，`conn.error` 字段就是原因（设备不存在、固件不匹配、链路故障）。

### 49321 端口被占用

本地程序会自动往后找空闲端口并打印，请以打印出的地址为准，不要假定是 49321。

### 关掉窗口就是退出程序

这是刻意设计：窗口属于这个程序，关掉它就会结束会话——机械臂失能、串口释放。**刷新页面不会退出**，只有关窗口才会。

再次启动就是一个干净的会话。如果确实还有实例在跑（旧版本，或者图标被点了两次），再次启动**会把那个实例的窗口抬到前面**，而不是另起第二个程序。

### 窗口说串口打不开，可机械臂明明是连着的

握着机械臂的那个程序还在跑，而你又起了第二个——因为你在启动时点名了某种会话（`--port`、`--fake`、`--can-channel` 等）。用 `http://127.0.0.1:49321/api/health` 确认在跑的那个，关掉第二个窗口，去掉这些选项重新启动即可接上已经在跑的会话。
