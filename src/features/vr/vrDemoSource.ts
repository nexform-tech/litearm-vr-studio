import type { VrLinkSnapshot } from './vrTypes'

/**
 * 本地演示数据源：不连任何设备，本地生成"看起来在跑"的一路数据。
 *
 * 存在的意义有两个：一是桥还没接上时页面不至于空着，二是没有机械臂也能开发
 * 和回归界面。真实数据源就绪后它自动退居兜底（桥在线时页面走桥）。
 */

/** 头显帧间隔：Pico 4 Ultra 实测 90Hz */
const FRAME_INTERVAL_MS = 1000 / 90
const NOMINAL_FPS = 90
const DEMO_LATENCY_MS = 16

/** metavr 的遥操就绪姿态，与 vr/metavr/src/litearm_teleop/teleop_sim.py 的 Q_HOME 一致 */
const Q_READY = [0, -0.07, -0.09, -1.7, -1.46, -0.03, -0.79]

type DemoState = Pick<
  VrLinkSnapshot,
  'headsetOnline' | 'following' | 'fps' | 'latencyMs' | 'sinceFrameMs' | 'frames' | 'q'
>

export class VrDemoSource {
  private q = [...Q_READY]
  private elapsed = 0
  private frames = 0
  private lastFrameAt = 0
  private following = false
  private offline = false

  get jointAngles(): number[] {
    return this.q
  }

  get isOffline(): boolean {
    return this.offline
  }

  /** 启动时调用：把「最近一帧」的时间基准落到当前时刻 */
  reset(now: number) {
    this.lastFrameAt = now
  }

  setOffline(offline: boolean, now: number) {
    this.offline = offline
    if (offline) this.following = false
    else this.lastFrameAt = now
  }

  startFollow() {
    if (!this.offline) this.following = true
  }

  stopFollow() {
    this.following = false
  }

  step(now: number, dt: number): DemoState {
    if (this.offline) {
      return {
        headsetOnline: false,
        following: false,
        fps: 0,
        latencyMs: 0,
        sinceFrameMs: Math.round(now - this.lastFrameAt),
        frames: this.frames,
        q: this.q,
      }
    }

    // 按 90Hz 推进「最近一帧」的时间戳，sinceFrameMs 因此落在 0~11ms
    while (now - this.lastFrameAt >= FRAME_INTERVAL_MS) {
      this.lastFrameAt += FRAME_INTERVAL_MS
      this.frames += 1
    }

    if (this.following) {
      this.elapsed += dt
      for (let i = 0; i < this.q.length; i += 1) {
        this.q[i] = Q_READY[i] + Math.sin(this.elapsed * 0.8 + i * 0.55) * 0.12
      }
    }

    return {
      headsetOnline: true,
      following: this.following,
      fps: NOMINAL_FPS + Math.sin(now / 700) * 2,
      latencyMs: DEMO_LATENCY_MS + Math.sin(now / 900) * 4,
      sinceFrameMs: Math.round(now - this.lastFrameAt),
      frames: this.frames,
      q: this.q,
    }
  }
}
