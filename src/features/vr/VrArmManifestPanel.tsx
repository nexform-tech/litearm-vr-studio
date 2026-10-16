import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ArmManifestRow, ArmManifestView, PortCandidate } from './useArmManifest'

/**
 * 臂映射：哪条串口接在哪条臂、夹爪在哪个 CAN 口。
 *
 * 这一页唯一**会改机器去向**的入口 —— 它决定哪条 follow 开哪个口、哪只手柄驱动哪条臂、
 * 汇总服务拿哪个口名去对拍夹爪。所以它读三样东西，一样都不合并（见 `useArmManifest`）：
 * 桥认的口、这个口是谁定的、服务真正回的口。三者里任意两个不一致，都要在**按下"开始遥操"
 * 之前**看得见。
 *
 * ⚠ 改的是**桥那台机器**上的记录，不是这张卡的状态：换台上位机连过来、桥重启，看到的
 *   都是同一份答案。页面上不写"已保存到本机"这种话（那是假的）。
 *
 * ⚠ **两类口不通用**：臂是串口（`by-id` / `serial`）、夹爪是 CAN（`can`）。每一格只列
 *   自己那一类 —— 列全了看着"什么都能选"，而挑一个 CAN 口当串口是当场就废的映射。
 *
 * ⚠ 候选口**由桥给**（`ports.list`）：默认同机、允许跨机，本机枚举出来的口与真正插着臂
 *   的那台可能毫无关系。列不出来（老版桥没有这条动作、daemon 正在重连）时退回**手填**，
 *   而不是把这一格留成空的 —— 那时候操作员至少还能把口名敲进去。
 */
export function VrArmManifestPanel({ v }: { v: ArmManifestView }) {
  const { t } = useTranslation('vr')
  // 操作员改过的那些口（只存改动，不存整份）：桥的快照每 100ms 来一份，
  // 存整份会让"正在挑"的那个选择被下一份快照冲掉。两类口各存一份。
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [gripDrafts, setGripDrafts] = useState<Record<string, string>>({})

  const effective = useMemo(() => {
    const out: Record<string, string> = {}
    for (const row of v.rows) out[row.arm] = drafts[row.arm] ?? row.device
    return out
  }, [drafts, v.rows])

  const effectiveGrip = useMemo(() => {
    const out: Record<string, string> = {}
    for (const row of v.rows) out[row.arm] = gripDrafts[row.arm] ?? row.gripper
    return out
  }, [gripDrafts, v.rows])

  const dirty =
    v.rows.some((row) => effective[row.arm] !== row.device) ||
    v.rows.some((row) => effectiveGrip[row.arm] !== row.gripper)

  // 保存成功就把草稿清掉：桥的快照随即报新值，这里再留着就成了"改了两遍"的假象
  useEffect(() => {
    if (v.saved) {
      setDrafts({})
      setGripDrafts({})
    }
  }, [v.saved])

  // 又动手改了就把"已保存"收起来：那句话说的是上一个状态，留着会让人以为这一改已经存过了
  const showSaved = v.saved !== null && !dirty

  // 改动被撤销（回到与桥一致）时把上一次的拒绝收起来：那句话说的是**上一个尝试**，
  // 而卡片此刻已经没有任何待存的东西了 —— 留着它会让人以为"还没改回来"。
  const dismissError = v.dismissError
  useEffect(() => {
    if (!dirty) dismissError()
  }, [dirty, dismissError])

  /** 保存：只送**这次改动过**的那几条（没动的不写，见桥那边的记录语义）。 */
  const onSave = () => {
    const devices: Record<string, string> = {}
    const grippers: Record<string, string> = {}
    for (const row of v.rows) {
      if (effective[row.arm] !== row.device) devices[row.arm] = effective[row.arm]
      if (effectiveGrip[row.arm] !== row.gripper) {
        grippers[row.arm] = effectiveGrip[row.arm]
      }
    }
    v.save(devices, grippers)
  }

  return (
    <Card className="gap-2.5 rounded-[0.875rem] px-3.5 py-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[0.90625rem] font-semibold text-foreground">
            {t('manifest.title')}
          </div>
          <div className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            {t('manifest.hint')}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 flex-none rounded-[0.5rem] px-2 text-[0.6875rem]"
          disabled={!v.canEdit || v.loadingPorts}
          onClick={v.refreshPorts}
        >
          {t('manifest.refresh')}
        </Button>
      </div>

      {v.rows.length === 0 ? (
        <div className="text-[0.71875rem] text-muted-foreground">{t('manifest.noArms')}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {v.rows.map((row) => (
            <ArmRow
              key={row.arm}
              row={row}
              value={effective[row.arm] ?? ''}
              gripperValue={effectiveGrip[row.arm] ?? ''}
              ports={v.ports}
              disabled={!v.canEdit}
              onChange={(next) => setDrafts((prev) => ({ ...prev, [row.arm]: next }))}
              onChangeGripper={(next) =>
                setGripDrafts((prev) => ({ ...prev, [row.arm]: next }))
              }
            />
          ))}
        </div>
      )}

      {!v.canEdit && v.rows.length > 0 ? (
        <div className="text-[0.6875rem] leading-relaxed text-muted-foreground">
          {t('manifest.busy')}
        </div>
      ) : null}

      {v.error ? (
        <div className="flex items-start gap-1.5 rounded-[0.625rem] border border-danger-line bg-danger-soft px-2.5 py-2">
          <TriangleAlert size="0.875rem" className="mt-[0.0625rem] flex-none text-danger" />
          <div className="min-w-0 text-[0.6875rem] leading-relaxed break-words text-danger">
            {v.error}
          </div>
        </div>
      ) : null}

      {showSaved ? (
        <div className="text-[0.6875rem] text-ok">
          {v.saved && v.saved.length > 0
            ? t('manifest.saved', { arms: v.saved.join('、') })
            : t('manifest.savedNothing')}
        </div>
      ) : null}

      {v.portsError ? (
        <div className="text-[0.65625rem] leading-relaxed text-muted-foreground">
          {t('manifest.portsUnavailable', { reason: v.portsError })}
        </div>
      ) : null}

      <Button
        type="button"
        disabled={!v.canEdit || v.saving || !dirty}
        onClick={onSave}
        className="h-9 w-full rounded-[0.625rem] text-[0.8125rem] font-semibold"
      >
        {v.saving ? t('manifest.saving') : t('manifest.save')}
      </Button>
    </Card>
  )
}

/** 候选口的标签：`by-id` 是稳定的身份，`ttyACM0` 那类拔插一次就可能换人。 */
function portLabel(candidate: PortCandidate, t: (key: string) => string): string {
  const kind = t(`manifest.kind.${candidate.kind}`)
  return kind === `manifest.kind.${candidate.kind}`
    ? candidate.path
    : `${candidate.path}（${kind}）`
}

/** 这一格能选哪几类口：臂是串口、夹爪是 CAN —— 两类不通用（见文件头）。 */
const KINDS_OF = {
  arm: ['by-id', 'serial'],
  gripper: ['can'],
} as const

function portsFor(ports: PortCandidate[], which: 'arm' | 'gripper'): PortCandidate[] {
  const kinds: readonly string[] = KINDS_OF[which]
  return ports.filter((port) => kinds.includes(port.kind))
}

/**
 * 一格口：候选下拉，列不出来时退回手填。
 *
 * 当前值不在候选里也照样显示（桥刚重启、设备还没枚举出来、手上是别人手填的口名都不该让
 * 这一格变空）。
 */
function PortField({
  id,
  label,
  value,
  ports,
  disabled,
  placeholder,
  onChange,
}: {
  id: string
  label: string
  value: string
  ports: PortCandidate[]
  disabled: boolean
  placeholder: string
  onChange: (next: string) => void
}) {
  const { t } = useTranslation('vr')
  const options =
    ports.some((p) => p.path === value) || !value
      ? ports
      : [{ path: value, kind: '' }, ...ports]

  return (
    <div className="flex items-center gap-1.5">
      <span className="w-8 flex-none text-[0.65625rem] text-ink-muted">{label}</span>
      {ports.length === 0 ? (
        <Input
          aria-label={id}
          data-testid={`manifest-input-${id}`}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          className="h-8 flex-1 font-mono text-[0.6875rem]"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Select value={value} disabled={disabled} onValueChange={onChange}>
          <SelectTrigger
            data-testid={`manifest-select-${id}`}
            className="h-8 w-full flex-1 font-mono text-[0.6875rem]"
          >
            <SelectValue placeholder={t('manifest.pick')} />
          </SelectTrigger>
          <SelectContent>
            {options.map((candidate) => (
              <SelectItem key={candidate.path} value={candidate.path}
                          className="font-mono text-[0.6875rem]">
                {portLabel(candidate, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}

function ArmRow({
  row,
  value,
  gripperValue,
  ports,
  disabled,
  onChange,
  onChangeGripper,
}: {
  row: ArmManifestRow
  value: string
  gripperValue: string
  ports: PortCandidate[]
  disabled: boolean
  onChange: (next: string) => void
  onChangeGripper: (next: string) => void
}) {
  const { t } = useTranslation('vr')
  const sideKey = row.side === 'left' ? 'left' : row.side === 'right' ? 'right' : 'unknown'
  // 桥认的口与真机回的口不符：这是**动错臂**的前兆，不是一条提示性文案
  const mismatch = Boolean(row.device && row.reported && row.device !== row.reported)
  // 夹爪同理：`grip_iface` 就是喂给汇总服务对拍的那一个
  const gripMismatch = Boolean(
    row.gripper && row.reportedGripper && row.gripper !== row.reportedGripper,
  )
  // 这条臂有没有夹爪由**桥**说了算（`ARM_x_GRIP` 没配就是没有）：没有的东西没有口可指认，
  // 界面也不该摆一格空的让操作员选
  const hasGripper = Boolean(row.gripper || row.reportedGripper)

  return (
    <div className="flex flex-col gap-1 rounded-[0.625rem] border border-line-soft px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex-none text-[0.71875rem] font-semibold text-foreground">
            {t(`manifest.side.${sideKey}`)}
          </span>
          <span className="truncate font-mono text-[0.625rem] text-ink-muted">{row.arm}</span>
        </div>
        <span className="flex-none text-[0.625rem] text-muted-foreground">
          {row.source === 'record'
            ? t('manifest.sourceRecord')
            : row.source === 'config'
              ? t('manifest.sourceConfig')
              : t('manifest.sourceUnknown')}
        </span>
      </div>

      <PortField
        id={`device-${row.arm}`}
        label={t('manifest.armPort')}
        value={value}
        ports={portsFor(ports, 'arm')}
        disabled={disabled}
        placeholder="/dev/ttyACM0"
        onChange={onChange}
      />

      {hasGripper ? (
        <PortField
          id={`gripper-${row.arm}`}
          label={t('manifest.gripperPort')}
          value={gripperValue}
          ports={portsFor(ports, 'gripper')}
          disabled={disabled}
          placeholder="can0"
          onChange={onChangeGripper}
        />
      ) : null}

      {row.confirmedAt ? (
        <div className="text-[0.625rem] text-muted-foreground">
          {t('manifest.confirmedAt', { time: row.confirmedAt })}
        </div>
      ) : null}

      {mismatch ? (
        <div className="text-[0.65625rem] leading-relaxed text-danger">
          {t('manifest.mismatch', { device: row.reported })}
        </div>
      ) : null}

      {gripMismatch ? (
        <div className="text-[0.65625rem] leading-relaxed text-danger">
          {t('manifest.gripperMismatch', { device: row.reportedGripper })}
        </div>
      ) : null}
    </div>
  )
}
