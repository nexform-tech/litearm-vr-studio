/**
 * The models the 3D viewport loads, and what it needs to know about each.
 *
 * Two models, from two places, and the difference matters:
 *
 *   `SINGLE_ARM_MODEL`  the arm's own model — **not in this repository**.
 *                       `scripts/fetch-description.mjs` pulls it from upstream
 *                       (`nexform-tech/litearm-description`, the version pinned in
 *                       `description.lock.json`) into `public/description/` before every dev,
 *                       build and test run. The directory layout and the file names are
 *                       byte-identical to upstream's package.
 *
 *   `DUAL_ARM_MODEL`    the two-arm rig the VR page draws — **in this repository**, under
 *                       `public/description-dual/` (low-poly meshes; see that directory's
 *                       README for where it came from and why it is vendored).
 *
 * These live in their own module rather than in `RobotViewport.tsx` for two reasons:
 * a component file should export only components (react-refresh), and
 * `src/description.model.test.ts` checks these names against the models that are actually on
 * disk — without dragging three.js into that test.
 */

/** One articulated chain: the arm's own, or one side of a two-arm rig. */
export type RobotChain = {
  /** Which side this chain is; `''` for a model that has only one. Matches the arm's `side`. */
  id: '' | 'left' | 'right'
  /** Joint names, in the order the viewport sets positions. Must match the URDF's joints. */
  joints: string[]
  /** Which link this chain's end-effector axes hang from. */
  endEffector: string
}

export type RobotModel = {
  /** Shown on the viewport's model chip (i18n keeps the surrounding text). */
  label: string
  /** The URDF, as a URL the page can fetch (`public/` + `BASE_URL`). */
  url: string
  /** Where any `package://` name resolves to — see the note in `RobotViewport`. */
  workingPath: string
  /** The link the base axes hang from (falls back to the root when it is not there). */
  baseLink: string
  /** One or more chains; the viewport drives them by `id`. */
  chains: RobotChain[]
}

/**
 * X rotation applied to every loaded robot, so it stands up in the scene.
 *
 * ⚠ This belongs to the **scene**, not to a model: both URDFs are ROS exports (Z-up) and the
 *   viewport is a three.js scene (Y-up), so every one of them needs the same quarter turn.
 *   It is *not* a per-model setting — treating it as one is how the rig ended up lying on its
 *   back while the arm stood up, since the arm's own model had carried this tip inline since
 *   the viewport was written.
 */
export const MODEL_TILT_X = -Math.PI / 2

/** Where the arm's own model sits under `public/` — and where any `package://` name resolves. */
export const MODEL_DIR = 'description/'
/** The URDF the viewport loads by default, relative to `public/`. */
export const MODEL_PATH = `${MODEL_DIR}urdf/litearm_description.urdf`

/** Joint names, in the order the viewport sets positions. Must match the URDF's joints. */
export const JOINT_NAMES = ['joint1', 'joint2', 'joint3', 'joint4', 'joint5', 'joint6', 'joint7']
/** Which link the end-effector axes hang from. */
export const END_EFFECTOR_LINK = 'ee_link'

export const SINGLE_ARM_MODEL: RobotModel = {
  label: 'studio',
  url: `${import.meta.env.BASE_URL}${MODEL_PATH}`,
  workingPath: `${import.meta.env.BASE_URL}${MODEL_DIR}`,
  baseLink: 'base_link',
  chains: [{ id: '', joints: JOINT_NAMES, endEffector: END_EFFECTOR_LINK }],
}

/** Where the two-arm rig's model sits under `public/`. */
export const DUAL_MODEL_DIR = 'description-dual/'
export const DUAL_MODEL_PATH = `${DUAL_MODEL_DIR}urdf/dual_litearm_column.urdf`

/** How many joints each chain of the rig has — the URDF has seven per side. */
const DUAL_JOINTS_PER_CHAIN = 7

/**
 * The rig's joint names: `left_Joint1…7` / `right_Joint1…7`.
 *
 * ⚠ Built from the side rather than listed: the URDF names both chains symmetrically, and a
 *   hand-written list is one typo away from silently driving six of seven joints. The names
 *   are checked against the URDF itself by `src/description.model.test.ts`.
 */
export function dualJointNames(side: 'left' | 'right'): string[] {
  return Array.from({ length: DUAL_JOINTS_PER_CHAIN }, (_, i) => `${side}_Joint${i + 1}`)
}

export const DUAL_ARM_MODEL: RobotModel = {
  label: 'metavr · dual',
  url: `${import.meta.env.BASE_URL}${DUAL_MODEL_PATH}`,
  workingPath: `${import.meta.env.BASE_URL}${DUAL_MODEL_DIR}`,
  baseLink: 'column_base_link',
  chains: [
    { id: 'left', joints: dualJointNames('left'), endEffector: 'left_ee_frame_link' },
    { id: 'right', joints: dualJointNames('right'), endEffector: 'right_ee_frame_link' },
  ],
}
