/**
 * What this file pins: the model the build fetched is one this application knows how to
 * drive — every mesh it references is on disk, and its joints and links carry the names
 * `RobotViewport` sets positions on and hangs the end-effector axes from.
 *
 * Why it exists: the model is **not in git**. It is fetched at build time from another
 * repository we do not own (`nexform-tech/litearm-description`), and a local build follows
 * that repository's newest tag automatically. Nothing else stands between an upstream
 * rename and a shipped 3D panel that draws the ground plane and no arm — which is exactly
 * what issue #150 looked like. `description.lock.json` pins the bytes for release builds;
 * this pins the *meaning* of those bytes.
 *
 * ⚠ It fails, and does not skip, when the model is absent: a skipped guard is not a guard.
 * `pnpm test` fetches the model first (package.json), so that failure means someone ran
 * vitest directly on a machine that never built, or a fetch was interrupted.
 */
/// <reference types="node" />
// 上面这一行是这个文件对 node 类型的一次**逐文件**订阅: 应用的 tsconfig 只放行
// `vite/client` (src/ 是浏览器代码, 不该随手 import node 内建)。这里要读磁盘, 所以单独声明。
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import {
  DUAL_ARM_MODEL,
  DUAL_MODEL_DIR,
  DUAL_MODEL_PATH,
  END_EFFECTOR_LINK,
  JOINT_NAMES,
  MODEL_DIR,
  MODEL_PATH,
} from './components/robotModel'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const URDF = join(ROOT, 'public', MODEL_PATH)
/** Where `loader.packages` sends every `package://` name, so where the meshes must be. */
const MESH_ROOT = join(ROOT, 'public', MODEL_DIR)

/** 双臂支架那份：**随仓库带**的（不是构建时拉的），见它自己目录里的 README。 */
const RIG_URDF = join(ROOT, 'public', DUAL_MODEL_PATH)
const RIG_MESH_ROOT = join(ROOT, 'public', DUAL_MODEL_DIR)

function loadModel() {
  if (!existsSync(URDF)) {
    throw new Error(
      `${MODEL_PATH} is not there. The robot model is fetched at build time, not committed — ` +
        'run `node scripts/fetch-description.mjs` (or `pnpm build`, which does it first).',
    )
  }
  return readFileSync(URDF, 'utf8')
}

function loadRig() {
  if (!existsSync(RIG_URDF)) {
    throw new Error(
      `${DUAL_MODEL_PATH} is not there. That one **is** committed — a missing file means ` +
        'someone deleted it from the tree, not that a fetch was skipped.',
    )
  }
  return readFileSync(RIG_URDF, 'utf8')
}

/** `name` of every `<tag ...>` in `xml`, in document order. Attribute order does not matter. */
function tagNames(xml: string, tag: string) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))]
    .map(([element]) => /\bname="([^"]+)"/.exec(element)?.[1])
    .filter((name): name is string => Boolean(name))
}

/** Every `package://<pkg>/<path>` a visual or collision points at, resolved against MESH_ROOT. */
function meshFiles(xml: string) {
  return [...xml.matchAll(/filename="package:\/\/[^/]+\/([^"]+)"/g)].map(([, path]) => path)
}

it('drives exactly the joints the model has, in the order it declares them', () => {
  const model = loadModel()
  const joints = [...model.matchAll(/<joint\b[^>]*>/g)]
    .filter(([element]) => /\btype="revolute"/.test(element))
    .map(([element]) => /\bname="([^"]+)"/.exec(element)?.[1])

  expect(joints).toEqual([...JOINT_NAMES])
})

it('hangs the end-effector axes on a link that exists', () => {
  const links = tagNames(loadModel(), 'link')

  expect(links).toContain('base_link') // the viewport looks this one up too
  expect(links).toContain(END_EFFECTOR_LINK)
})

it('references only meshes that are on disk, and leaves no others behind', () => {
  const meshes = meshFiles(loadModel())

  expect(meshes.length).toBeGreaterThan(0)
  expect(meshes.filter((path) => !existsSync(join(MESH_ROOT, path)))).toEqual([])

  // The other direction, because the fetch is a mirror: a model that changed what its links
  // are named leaves the old meshes here otherwise, and they ship in `dist/` and stay
  // reachable at their old URLs.
  const referenced = new Set(meshes.map((path) => path.replace(/^meshes\//, '')))
  const onDisk = readdirSync(join(MESH_ROOT, 'meshes'))
  expect(onDisk.filter((name) => !referenced.has(name))).toEqual([])
})

it('has the bytes the lock pins, not just the file names', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'description.lock.json'), 'utf8')) as {
    files: Record<string, string>
  }
  const digest = `sha256:${createHash('sha256').update(readFileSync(URDF)).digest('hex')}`

  // Only the URDF: it is 12 KB. The meshes are 60 MB, and the fetch hashes all ten on every
  // run anyway — this test is for someone running vitest directly, with no fetch in front.
  expect(digest).toBe(lock.files[MODEL_PATH.slice(MODEL_DIR.length)])
})

it('pins exactly the files the model needs in the lock file', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'description.lock.json'), 'utf8')) as {
    ref: string
    files: Record<string, string>
  }
  const pinned = Object.keys(lock.files)
  // The lock speaks the upstream package's paths; the model is a copy of that package.
  const needed = [MODEL_PATH.slice(MODEL_DIR.length), ...meshFiles(loadModel())]

  // Both directions, because either gap is silent: a file the model needs but the lock does
  // not cover is never hash-checked on fetch, and a lock entry nothing references is a pin
  // that has quietly stopped pinning anything.
  expect(needed.filter((path) => !pinned.includes(path))).toEqual([])
  expect(pinned.filter((path) => !needed.includes(path))).toEqual([])
  expect(lock.ref).toMatch(/^v?\d+\.\d+\.\d+$/)
})

// ── 双臂支架那份（随仓库带的） ──────────────────────────────────────────────
//
// 它与上面那份的**来源不同**（那份是构建时从另一个仓库拉的，有 lock 的哈希兜着），
// 但坏法是一样的、也是无声的：URDF 里改了关节名或挪了网格，页面上就只剩地面加一副
// 坐标轴 —— 而且因为网格是低模、关节是 seven-per-side，肉眼看不出少了什么。
//
// 所以这里钉的东西与上面那组刻意一致：名字对得上、网格在盘上、没有多余的残留。

it('双臂：两条链的关节名就是视口要驱动的那两组', () => {
  const joints = [...loadRig().matchAll(/<joint\b[^>]*>/g)]
    .filter(([element]) => /\btype="revolute"/.test(element))
    .map(([element]) => /\bname="([^"]+)"/.exec(element)?.[1])

  expect(joints).toEqual([...DUAL_ARM_MODEL.chains[0].joints, ...DUAL_ARM_MODEL.chains[1].joints])
})

it('双臂：每条链的末端坐标轴都挂在一个存在的 link 上', () => {
  const links = tagNames(loadRig(), 'link')

  expect(links).toContain(DUAL_ARM_MODEL.baseLink)
  for (const chain of DUAL_ARM_MODEL.chains) {
    expect(links).toContain(chain.endEffector)
  }
})

it('双臂：只引用盘上有的网格，也不留下没人用的', () => {
  const meshes = meshFiles(loadRig())

  expect(meshes.length).toBeGreaterThan(0)
  expect(meshes.filter((path) => !existsSync(join(RIG_MESH_ROOT, path)))).toEqual([])

  // 反方向同上：这份是随仓库带的，删掉网格不会有人拦，而它照样进 `dist/`
  const referenced = new Set(meshes.map((path) => path.replace(/^meshes\//, '')))
  const onDisk = readdirSync(join(RIG_MESH_ROOT, 'meshes'))
  expect(onDisk.filter((name) => !referenced.has(name))).toEqual([])
})
