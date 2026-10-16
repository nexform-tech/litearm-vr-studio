# 双臂支架模型（随仓库带的那一份）

这个目录里是双臂现场那份模型：`dual_litearm_column_description` 的 URDF 与**低模**网格，
VR 页的 3D 预览在认到两条臂时加载它（`src/features/vr/VrPreviewPanel.tsx`）。

## 它为什么在这里，而不是跟另一份一样构建时拉取

机械臂自己那份模型（`public/description/`）是 `scripts/fetch-description.mjs` 在每次
dev/build/test 前从 `nexform-tech/litearm-description` 拉的，版本由 `description.lock.json`
钉住。**那个仓库里没有双臂这份**（截至 v2.0.0 只有单臂的 `litearm_description.urdf`），
而 VR 页要画的就是双臂现场：两条**侧装**臂（两个 mount joint 都是 `roll=-90°`）挂在同一根
立柱上。所以这里先带一份，等它进了上游描述包再换成拉取。

- 来源：`litearm-vr`（metavr）的 `dual_litearm_column_description/`
- 网格：`meshes_lowpoly/`（9.6 MB）。完整网格是 63 MB —— 预览用不上那个精度，
  而应用里已有的那份模型是 61 MB，再翻一倍不像话。
- URDF 保持原样（`package://dual_litearm_column_description/meshes/…`）：视口把任何
  包名都解析到这个目录（见 `RobotViewport` 里"用函数而不是查表"那段注释）。

## 什么时候要动它

- 上游 metavr 换了模型 → 这里跟着换，并且**两份一起**（URDF 与网格），
  否则网格名对不上时画面只剩地面加坐标轴。
- `src/description.model.test.ts` 钉着四条：两条链的关节名、两个末端 link 存在、
  网格都在盘上、没有多带的文件。改了模型它就该说话。
