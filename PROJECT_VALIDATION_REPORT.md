# 完整项目与历史工作流验证报告

检查日期：2026-11-04。适用 `codex/mask-tools` 分支。

## 结论

本轮最终 206 项单元测试通过，完整入口的 24 项任务全部通过。
相关 TypeScript 检查没有新增诊断；依赖补丁核对覆盖 7 个文件，并验证可从原版 Cornerstone 4.5.13 重现。
代码、验证脚本和说明随本次更新统一维护在 `codex/mask-tools` 分支。

## 环境与数据

Windows / Node.js v24.18.0 / 本机无界面 Microsoft Edge，使用软件 GPU。
OHIF 3.11.1 / Cornerstone 4.5.13；本地开发服务 `http://localhost:3000/local-mask`。
合成 CT 为 128×128×8；真实完整序列为肺部 114 张、腹部 52 张，共 166 张、83.30 MiB。
真实数据来源、脱敏标记及 DICOMweb 重封装方式见 [真实数据说明](REAL_DICOM_TEST_REPORT.md)。

## 全量执行清单

以下为本机每个完整脚本的总耗时，包含独立参考、浏览器启动、编辑和撤销等，不代表单个算法的耗时。

| 任务 | 结果 | 脚本耗时 / 秒 |
| --- | --- | ---: |
| `unit-tests` | 通过 | 0.5 |
| `dependency-patch` | 通过 | 0.0 |
| `basic-ui` | 通过 | 5.7 |
| `sphere` | 通过 | 5.0 |
| `selection` | 通过 | 3.3 |
| `volume` | 通过 | 9.9 |
| `mpr-brushes` | 通过 | 3.9 |
| `split` | 通过 | 4.5 |
| `workbench` | 通过 | 4.8 |
| `continuity` | 通过 | 8.7 |
| `dicom-seg` | 通过 | 6.2 |
| `appearance` | 通过 | 4.7 |
| `project` | 通过 | 11.2 |
| `roi-and-drafts` | 通过 | 24.1 |
| `refinement` | 通过 | 6.3 |
| `refinement-cancel` | 通过 | 13.3 |
| `frontend-workflow` | 通过 | 20.9 |
| `workspace-and-history` | 通过 | 9.3 |
| `real-ct-lung-and-abdomen` | 通过 | 56.8 |
| `real-project` | 通过 | 14.6 |
| `real-roi-and-drafts` | 通过 | 30.1 |
| `real-refinement` | 通过 | 56.8 |
| `real-frontend-workflow` | 通过 | 101.6 |
| `real-workspace-and-history` | 通过 | 18.6 |

## 新增专项结果

两组专项均保存和恢复三个标注集：原始选区、独立重叠副本、空集合。
其中包含空 Mask、不同 RGBA 颜色、独立填充 / 轮廓样式、锁定、两级显隐、共享 ROI 和选中项。

- 逐帧源 SOP UID 和像素散列与保存前一致，重叠像素没有合并或丢失。
- 在全新浏览器环境倒序重新导入原始 DICOM，可以恢复所有集合，并保留载入前已有的标注集。
- MPR 切换后继续保持当前选择、空集合和整体 / 单 Mask 显隐。合成数据还检查实际 MPR 与三维模型对象的可见性。
- 在第二个集合恢复时注入故障，第一组新集合也一并回滚；旧项目的像素、元数据、ROI 和选中项保持一致。
- 损坏内部文件或选择另一组原始 DICOM 时，在创建项目内容前拒绝。
- 恢复后仍可执行整组编辑并撤销，其他集合不变。
- 阈值和形态学历史显示实际目标、参数和更改数量；预览、保存、取消不占撤销步骤。
- 真实原生橡皮擦笔画也进入同一历史；撤销 / 重做、丢弃分支与实际 SDK 环形栈同步。
- 历史目标被删除时给出提示，不写入失效标签对象、不产生运行时错误。

本次专项文件体积：合成项目 12724 字节；真实腹部项目 424830 字节。
它们不含原始 CT，大小取决于标签复杂度和集合数量，并非固定压缩比例。

## 检查中修复的边界

1. 空集合附加到新视口时，SDK 自动创建 Mask 1；现在保留空集合语义。
2. 布局转换会改变选中集合；现在按原始序列保留明确选择。
3. MPR 失败回滚直接移除派生图像会触发共享缓存错误；现在先清理仅由新集合拥有的体数据。
4. 标注集整体显隐不应覆盖各 Mask 的偏好，且必须进入实际二维 / 三维渲染对象。
5. 批量恢复后的旧 FIFO 渲染队列可能积压或被空请求打断；改为逐帧合并请求，补充重复、重入与旧视口测试。
6. SDK 移除事件原先只被映射为修改事件，导致已删除集合仍尝试暂存；现在同步移除相关状态。
7. 删除目标或尚未完成笔画时，历史快捷操作返回可读提示，避免未处理异常。

## 复现

```powershell
corepack yarn install --frozen-lockfile
corepack yarn demo:data
corepack yarn demo:real-data
corepack yarn dev:mask
# 编译完成后，另一个终端：
corepack yarn test:mask-all
```

项目专项可单独运行 `corepack yarn test:mask-workspace` 和 `corepack yarn test:mask-workspace abdomen-ct`。
原始清单及各步骤日志位于 `.cache/full-mask-regression/`；专项报告、实际项目文件和截图位于 `.cache/mask-workspace/`。
安装脚本自动应用可重现的 SDK 补丁，更新依赖后需要重启开发服务；Webpack 缓存版本已同步更新。

本报告覆盖前端、所选静态 CT 和开发环境，不包含业务后端或生产部署，也不评价临床分割准确率。
功能范围和文件限制见 [项目工作流说明](PROJECT_WORKFLOW_NOTES.md)。
