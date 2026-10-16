import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SegmentedControl } from '@/components/SegmentedControl'
import { useBridgeConfig } from './useBridgeConfig'
import type { BridgeConfigRow } from './useBridgeConfig'

/**
 * 桥的配置面 —— 顶栏右上角那颗按钮点开的表单。
 *
 * 为什么收进弹窗、而不是在页面上再占一格：这一页六格摆的是**遥操时要一直盯着**的东西
 * （链路、负载、3D、臂映射）。配置改一次就不用再看了，占一格会把常看的那几张挤小。
 * 而它又必须在这一页上 —— 改的是同一台桥。
 *
 * 表单**不写死有哪些键**：能改哪些、各自什么取值、改完怎么生效、不给改的为什么，
 * 全是桥下发的（`config.schema`）。桥以后新增配置项，这里自动多一行。
 *
 * ⚠ 但**名字要给人看的**：桥下发的是键名（`ctrl_mode` 这种，写给配置文件看的，且全是
 *   英文）。所以按路径查一句人话（`config.label.<路径>`），**查不到就退回键名** ——
 *   桥新增的键照样出现，只是暂时没名字。两个取值那一类的键连两态的名字也给人话：
 *   写"开/关"对"真机"没有任何意义，得写"真机/仿真"。
 *
 * 三件事必须看得见，否则就是现场最难查的那类问题：
 *
 *   * **这个值来自哪一层** —— 出厂默认 / `config.toml` / 页面改过。页面改过的
 *     **压过**配置文件，所以"改了 config.toml 重启却什么都没变"是正常行为。
 *   * **改完怎么生效** —— 立即 / 重建受管进程的命令行（链路忙时桥会拒）/ 需重启桥。
 *     最后那一档存下去但**不当场生效**，页面上要写明，不能显示成已经生效。
 *   * **不给改的为什么** —— 也列出来、标只读、写明理由。操作员该知道为什么，
 *     而不是在页面上找不到它（找不到会以为是自己没看见）。
 *
 * ⚠ 改的是**桥那台机器**上的配置（一层覆盖，落在桥的家目录里），不是这个弹窗的状态：
 *   换台上位机连过去看到的是同一份。
 */
export function VrConfigButton() {
  const { t } = useTranslation('vr')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="vr-topbar-config"
        className="h-8 flex-none gap-1.5 rounded-[0.5rem] px-2.5 text-[0.75rem]"
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal className="size-3.5" />
        {t('config.open')}
      </Button>
      {/* 弹窗开着才挂载：`useBridgeConfig` 在挂载时拉一次配置面，
          关着的时候不该有一条常驻的取数在跑 */}
      {open ? <VrConfigDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  )
}

function VrConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('vr')
  const v = useBridgeConfig()
  // 只显示**能改**的项。只读的那些列出来只会占地方 —— 点不动，也没有可做的动作。
  const sections = groupBySection(v.rows.filter((row) => row.writable))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[40rem]" data-testid="vr-config-dialog">
        <DialogHeader>
          <DialogTitle>{t('config.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto pr-1">
          {v.rows.length === 0 ? (
            <div className="text-[0.8125rem] text-muted-foreground">
              {v.loading ? t('config.loading') : t('config.unavailable')}
            </div>
          ) : (
            sections.map(([section, rows]) => (
              <div key={section} className="flex flex-col gap-2">
                <div className="text-[0.75rem] font-medium tracking-wide text-muted-foreground">
                  {t(`config.section.${section}`, { defaultValue: section })}
                </div>
                {rows.map((row) => (
                  <ConfigRow
                    key={row.path}
                    row={row}
                    disabled={!v.canEdit || !row.writable}
                    onChange={(next) => v.set(row.path, next)}
                    onRevert={() => v.revert(row.path)}
                    onReset={() => v.reset(row.path)}
                  />
                ))}
              </div>
            ))
          )}

          {!v.canEdit && v.rows.length > 0 ? (
            <div className="text-[0.75rem] leading-relaxed text-muted-foreground">
              {t('config.busy')}
            </div>
          ) : null}

          {v.error ? (
            <div className="flex items-start gap-1.5 rounded-[0.625rem] border border-danger-line bg-danger-soft px-2.5 py-2 text-[0.75rem] leading-relaxed text-danger">
              <TriangleAlert className="mt-px size-4 flex-none" />
              {/* 桥拒绝的原话（"不从页面上改"、取值不认、链路忙…），不翻译 */}
              <span>{v.error}</span>
            </div>
          ) : null}

          {v.saved !== null ? (
            <div className="text-[0.75rem] text-muted-foreground">
              {v.saved.length === 0
                ? t('config.savedNothing')
                : t('config.saved', { keys: v.saved.join('、') })}
            </div>
          ) : null}

          {v.pendingRestart.length > 0 ? (
            <div className="text-[0.75rem] leading-relaxed text-warn">
              {t('config.pendingRestart', { keys: v.pendingRestart.join('、') })}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground">
            {v.overridesFile ? t('config.livesAt', { path: v.overridesFile }) : ''}
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-[0.5rem] text-[0.75rem]"
              disabled={!v.canEdit || v.loading}
              onClick={v.refresh}
            >
              {t('config.refresh')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="rounded-[0.5rem] text-[0.75rem]"
              disabled={!v.canEdit || v.saving || !v.rows.some((row) => row.dirty)}
              onClick={v.save}
            >
              {v.saving ? t('config.saving') : t('config.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function groupBySection(rows: BridgeConfigRow[]): Array<[string, BridgeConfigRow[]]> {
  const out = new Map<string, BridgeConfigRow[]>()
  for (const row of rows) {
    const bucket = out.get(row.section)
    if (bucket) bucket.push(row)
    else out.set(row.section, [row])
  }
  return [...out.entries()]
}

/** 这一项叫什么（给人看的）。查不到就退回键名 —— 桥新增的键照样能改。 */
function labelOf(
  t: (key: string, options?: Record<string, unknown>) => string,
  row: BridgeConfigRow,
): string {
  return t(`config.label.${row.path}`, { defaultValue: row.key })
}

/** 这一项的值是谁定的 —— 页面上最要紧的一件事（页面改过的压过配置文件）。 */
function sourceLabelKey(source: string): string {
  if (source === 'override') return 'config.sourceOverride'
  if (source === 'config') return 'config.sourceConfig'
  return 'config.sourceDefault'
}

function ConfigRow({
  row,
  disabled,
  onChange,
  onRevert,
  onReset,
}: {
  row: BridgeConfigRow
  disabled: boolean
  onChange: (value: unknown) => void
  onRevert: () => void
  onReset: () => void
}) {
  const { t } = useTranslation('vr')
  return (
    <div
      className="flex flex-col gap-1.5 rounded-[0.625rem] border border-line-soft px-3 py-2.5"
      data-testid={`config-row-${row.path}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-[0.8125rem] font-medium text-foreground">{labelOf(t, row)}</span>
        </div>
        <div className="flex flex-none items-center gap-2">
          {row.apply === 'restart' ? (
            <span className="text-[0.6875rem] text-warn">{t('config.needsRestart')}</span>
          ) : null}
          <span className="text-[0.6875rem] text-muted-foreground">
            {t(sourceLabelKey(row.source))}
          </span>
        </div>
      </div>

      <Control row={row} disabled={disabled} onChange={onChange} />

      {row.doc ? (
        <div className="text-[0.6875rem] leading-relaxed text-muted-foreground">{row.doc}</div>
      ) : null}

      {row.pending_restart ? (
        <div className="text-[0.6875rem] text-warn">{t('config.pendingThis')}</div>
      ) : null}

      <div className="flex items-center gap-3">
        {row.dirty ? (
          <button
            type="button"
            className="text-[0.6875rem] text-muted-foreground underline-offset-2 hover:underline"
            onClick={onRevert}
          >
            {t('config.revert')}
          </button>
        ) : null}
        {row.resetable ? (
          <button
            type="button"
            className="text-[0.6875rem] text-muted-foreground underline-offset-2 hover:underline"
            disabled={disabled}
            onClick={onReset}
          >
            {t('config.reset')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** 按桥说的 `kind` 选控件 —— 键名换了、增了，这里都不用改。 */
function Control({
  row,
  disabled,
  onChange,
}: {
  row: BridgeConfigRow
  disabled: boolean
  onChange: (value: unknown) => void
}) {
  const { t } = useTranslation('vr')

  if (row.kind === 'bool') {
    const on = row.draft === true || String(row.draft) === 'true'
    // 两态的名字也给人话：写"开/关"对"真机"没有任何意义。
    // 认得的键在 i18n 里给一对词，认不得就退回 开/关。
    const words = t(`config.bool.${row.path}`, {
      returnObjects: true,
      defaultValue: [t('config.on'), t('config.off')],
    }) as unknown as string[]
    const [onWord, offWord] = Array.isArray(words) ? words : ['开', '关']
    return (
      <SegmentedControl
        ariaLabel={row.path}
        items={[
          {
            key: 'on',
            label: onWord,
            active: on,
            disabled,
            title: t('config.boolHint', { on: onWord, off: offWord }),
            onClick: () => onChange(true),
          },
          {
            key: 'off',
            label: offWord,
            active: !on,
            disabled,
            title: t('config.boolHint', { on: onWord, off: offWord }),
            onClick: () => onChange(false),
          },
        ]}
        containerStyle={SEGMENT.containerStyle}
        itemStyle={SEGMENT.itemStyle}
        activeItemStyle={SEGMENT.activeItemStyle}
      />
    )
  }

  if (row.kind === 'enum') {
    return (
      <Select
        value={String(row.draft ?? '')}
        onValueChange={(next) => onChange(next)}
        disabled={disabled}
      >
        <SelectTrigger
          className="h-8 w-full text-[0.8125rem]"
          data-testid={`config-select-${row.path}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {row.values.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  // text / int / manage：都退回手填 —— 桥按声明的类型收值，写错它会当场点名
  return (
    <Input
      value={String(row.draft ?? '')}
      disabled={disabled}
      placeholder={t('config.noValue')}
      className="h-8 w-full font-mono text-[0.8125rem]"
      data-testid={`config-input-${row.path}`}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** 两态那两粒：与设置页同一套（这一页没有自己的设计语言，照抄才是对的）。 */
const SEGMENT = {
  containerStyle: {
    display: 'flex' as const,
    gap: '0.1875rem',
    background: 'var(--line-soft)',
    borderRadius: '0.5625rem',
    padding: '0.1875rem',
    alignSelf: 'flex-start' as const,
  },
  itemStyle: {
    padding: '0.25rem 0.75rem',
    borderRadius: '0.4375rem',
    fontSize: '0.8125rem',
    color: 'var(--ink-subtle)',
    fontWeight: 500,
  },
  activeItemStyle: {
    background: 'var(--seg-active)',
    color: 'var(--ink)',
    fontWeight: 600,
  },
}
