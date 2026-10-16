import { describe, expect, it, vi } from 'vitest'
import type { DaemonSocket } from '@/lib/arm/socket'
import { VrDaemonClient } from './vrDaemonClient'

/**
 * daemon 那条通道的接头：帧进 → 状态出，动作名映射，传输层一动就清干净。
 *
 * 真正的解析（zenoh、话题、上游载荷）在 daemon 那边测；这里钉的是页面这一侧
 * 的契约，尤其是**不再有"桥地址"**这件事。
 */

function fakeSocket() {
  const handlers = new Map<string, Set<(msg: Record<string, unknown>) => void>>()
  const lifecycle = new Set<() => void>()
  const sendCmd = vi.fn((): Promise<unknown> => Promise.resolve({ receipt: { ok: true } }))
  const socket = {
    onFrame: (tag: string, cb: (msg: Record<string, unknown>) => void) => {
      const set = handlers.get(tag) ?? new Set()
      set.add(cb)
      handlers.set(tag, set)
      return () => set.delete(cb)
    },
    onLifecycle: (cb: () => void) => {
      lifecycle.add(cb)
      return () => lifecycle.delete(cb)
    },
    sendCmd,
  } as unknown as DaemonSocket
  return {
    socket,
    sendCmd,
    emit: (tag: string, msg: Record<string, unknown>) => {
      for (const cb of handlers.get(tag) ?? []) cb(msg)
    },
    dropTransport: () => {
      for (const cb of lifecycle) cb()
    },
  }
}

const connFrame = { t: 'vr_conn', status: 'connected', endpoint: 'tcp/127.0.0.1:7447', arms: [] }

describe('VR 通道客户端（走 daemon）', () => {
  it('桥的连线状态来自 vr_conn，没到过就是离线', () => {
    const fake = fakeSocket()
    const client = new VrDaemonClient(fake.socket)
    expect(client.online).toBe(false)
    expect(client.endpoint).toBe('')

    fake.emit('vr_conn', connFrame)
    expect(client.online).toBe(true)
    expect(client.endpoint).toBe('tcp/127.0.0.1:7447')
  })

  it('快照按臂存，第一条臂就是"那份"（单臂部署的既有映射照旧吃它）', () => {
    const fake = fakeSocket()
    const client = new VrDaemonClient(fake.socket)

    fake.emit('vr_state', { t: 'vr_state', arm: 'armB', state: { ts: 2 } })
    fake.emit('vr_state', { t: 'vr_state', arm: 'armA', state: { ts: 1 } })

    expect(client.arms).toEqual(['armA', 'armB'])   // 排序稳定，页面按它渲染
    expect(client.snapshotFor('armB')?.ts).toBe(2)
    expect(client.snapshot?.ts).toBe(1)             // 第一条
  })

  it('真机状态与夹爪各存各的，按臂取', () => {
    const fake = fakeSocket()
    const client = new VrDaemonClient(fake.socket)

    fake.emit('vr_arm', { t: 'vr_arm', arm: 'armA', state: { device: '/dev/ttyACM0', q: [1] } })
    fake.emit('vr_grip', { t: 'vr_grip', arm: 'armA', state: { device: 'can0', q: -1.06 } })

    expect(client.armStateFor('armA')?.device).toBe('/dev/ttyACM0')
    expect(client.gripStateFor('armA')?.device).toBe('can0')
    expect(client.armStateFor('armB')).toBeNull()
  })

  it('动作译成 vr.* 命令；通道没通就不发', () => {
    const fake = fakeSocket()
    const client = new VrDaemonClient(fake.socket)

    expect(client.sendAction('estop')).toBe(false)
    expect(fake.sendCmd).not.toHaveBeenCalled()

    fake.emit('vr_conn', connFrame)
    expect(client.sendAction('teleop.start')).toBe(true)
    expect(fake.sendCmd).toHaveBeenCalledWith('vr.teleop_start', undefined)
    // 带参的动作要把参数**原样**送过去（丢参数是那种"传了却没生效"的错，最难查）
    expect(client.sendAction('teleop.start', { arm: 'armA' })).toBe(true)
    expect(fake.sendCmd).toHaveBeenLastCalledWith('vr.teleop_start', { arm: 'armA' })
  })

  it('臂映射：候选口与写回都走桥（命令名与参数原样）', async () => {
    const fake = fakeSocket()
    const client = new VrDaemonClient(fake.socket)
    fake.emit('vr_conn', connFrame)

    await client.listPorts()
    expect(fake.sendCmd).toHaveBeenLastCalledWith('vr.list_ports')

    await client.setArmDevices({ armA: '/dev/serial/by-id/usb-A' })
    expect(fake.sendCmd).toHaveBeenLastCalledWith('vr.set_arm_devices',
      { devices: { armA: '/dev/serial/by-id/usb-A' } })
  })

  it('回执存下来给页面读（急停没停成不能显示成成功）', async () => {
    const fake = fakeSocket()
    fake.sendCmd.mockResolvedValueOnce({
      receipt: { ok: false, code: 'estop_sent_failed', error: { message: '跟随服务不可达或拒绝' } },
    })
    const client = new VrDaemonClient(fake.socket)
    fake.emit('vr_conn', connFrame)

    client.sendAction('estop')
    await Promise.resolve()
    await Promise.resolve()

    expect(client.lastReceipt?.ok).toBe(false)
    expect(client.lastActionError).toBeNull()
  })

  it('daemon 那条连接一动，读数全清（不保留最后一帧"桥在线"）', () => {
    const fake = fakeSocket()
    const client = new VrDaemonClient(fake.socket)
    fake.emit('vr_conn', connFrame)
    fake.emit('vr_state', { t: 'vr_state', arm: 'armA', state: { ts: 1 } })
    fake.emit('vr_arm', { t: 'vr_arm', arm: 'armA', state: { q: [1] } })

    fake.dropTransport()

    expect(client.online).toBe(false)
    expect(client.arms).toEqual([])
    expect(client.snapshot).toBeNull()
    expect(client.armStateFor('armA')).toBeNull()
  })
})
