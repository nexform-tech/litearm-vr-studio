import { lazy } from 'react'

// 路由级按需加载：three.js 等重量级依赖只随 VR 页下载。
// VR-only 版本只保留遥操控制台，控制/日志/设置页已移除。
export const VrConsole = lazy(() => import('./features/vr/VrConsole').then((m) => ({ default: m.VrConsole })))
