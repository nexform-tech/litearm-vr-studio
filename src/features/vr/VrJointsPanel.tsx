import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui/card'
import type { VrLinkSnapshot } from './vrTypes'

/** 关节数固定为 7：没收到过真实姿态时就把 7 行空位摆出来，显示"—"而不是编一组数 */
const JOINT_COUNT = 7

export function VrJointsPanel({ q, stale = false }: { q: VrLinkSnapshot['q']; stale?: boolean }) {
  const { t } = useTranslation('vr')
  const rows = q ?? Array.from({ length: JOINT_COUNT }, () => null)

  return (
    <Card className="gap-2.5 rounded-[0.875rem] px-3.5 py-3.5">
      <div className="flex items-center justify-between">
        <div className="text-[0.90625rem] font-semibold text-foreground">{t('joints.title')}</div>
        {stale ? (
          <div className="text-[0.6875rem] text-warn">{t('joints.waiting')}</div>
        ) : (
          <div className="font-mono text-[0.6875rem] text-muted-foreground">{t('joints.unit')}</div>
        )}
      </div>
      <div className="flex flex-col gap-[0.1875rem]">
        {rows.map((v, i) => (
          <div key={i} className="flex items-center gap-2.5 rounded-[0.4375rem] px-2 py-1 odd:bg-muted/40">
            <div className="w-6 font-mono text-[0.71875rem] text-muted-foreground">J{i + 1}</div>
            <div className="flex-1 text-right font-mono text-[0.8125rem] text-foreground">
              {v === null ? (
                <span className="text-ink-faint">—</span>
              ) : (
                <>
                  {v >= 0 ? '+' : '−'}
                  {Math.abs(v).toFixed(3)}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
