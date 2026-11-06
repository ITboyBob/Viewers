# 单人标注与 DICOM 后端接口需求

版本：v0.1，供小组开发和联调使用。适用分支：`codex/mask-tools`。

**本文是待实现的接口约定，不代表仓库中已有后端服务。** 当前演示使用浏览器本地 DICOM，
运行时标注驻留浏览器，已支持 `.ohifmask` 文件保存恢复及浏览器本地自动暂存；
本分支尚未接入下述远端保存、上传、自动保存和恢复接口。
使用方法见 [MASK_DEMO_README.md](MASK_DEMO_README.md)，可导入 Swagger Editor / Apifox 的业务接口定义见
[docs/mask-backend.openapi.yaml](docs/mask-backend.openapi.yaml)。

## 1. 最小实现范围与分工

目标是完成“上传一组 CT → 打开影像 → 标注 → 保存 → 关闭页面 → 重新打开并继续编辑”。
按照单人使用设计，不需要多人光标、实时同步、任务分配、标注审批或协作锁。

| 内容 | 负责方 | 优先级 |
| --- | --- | --- |
| DICOM 文件入库、按 Study / Series / Instance 检索、原始像素读取 | 后端 / DICOM 存储服务 | P0 |
| 标注集与原始序列绑定、快照保存和读取、版本号、失败不覆盖旧数据 | 业务后端 | P0 |
| Mask 名称、颜色、显隐、锁定状态与像素一起保存 | 前后端共同 | P0 |
| 阈值、画笔、橡皮擦、Region Grow、填洞、Split Mask | 当前前端已有；本期继续在前端执行 | 已有 |
| MPR、三维表面显示及本次编辑会话的撤销重做 | 当前前端 | 已有 |
| DICOM SEG 导出、`.ohifmask` 保存恢复、浏览器本地暂存及错误提示 | 当前前端 | 已有 |
| 基于业务接口的远端保存、自动保存 / 恢复，以及后端 SEG 返回数据的导入适配 | 前端后续接入 | P0 |
| 历史版本列表、恢复旧版本、软删除、STL / NIfTI 导出、大文件分片上传 | 后续扩展 | P1 |

推荐使用 **Orthanc + DICOMweb 插件**，或已有 DICOMweb PACS。业务后端负责标注记录和文件存储，
通过反向代理提供统一入口。无需为当前阈值、区域生长、填洞、拆分再开发一套后端算法接口。

建议同源路径：`/dicomweb` 提供标准影像服务，`/api/v1` 提供业务接口。框架、数据库和对象存储由后端成员选择。

## 2. DICOM 服务要求

### 2.1 查询与读取：复用 DICOMweb

下表是后端或 PACS 需要提供的标准服务，不是自定义 JSON 接口。业务 OpenAPI 不重复定义完整 DICOMweb 标准。

| 方法与路径 | 用途 | 返回类型 |
| --- | --- | --- |
| `GET /dicomweb/studies` | 检索检查，支持 StudyInstanceUID、PatientID、StudyDate、分页等 QIDO 参数 | `application/dicom+json` |
| `GET /dicomweb/studies/{studyUID}/series` | 检索序列，支持 SeriesInstanceUID、Modality 过滤 | `application/dicom+json` |
| `GET /dicomweb/studies/{studyUID}/series/{seriesUID}/instances` | 查询实例和 SOP Instance UID | `application/dicom+json` |
| `GET /dicomweb/studies/{studyUID}/series/{seriesUID}/metadata` | 读取整个序列的 DICOM 元数据 | `application/dicom+json` |
| `GET /dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{sopUID}/metadata` | 读取单实例元数据 | `application/dicom+json` |
| `GET /dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{sopUID}/frames/{frameNumbers}` | WADO-RS 原始帧，帧号从 1 开始 | `multipart/related`，按 Accept 协商像素传输语法 |
| `GET /dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{sopUID}` | WADO-RS 原始 DICOM 下载，也用于读取 SEG | `multipart/related; type="application/dicom"` |

要求遵循 DICOM JSON 的标签对象格式，如 `0020000D` 的 `vr`、`Value`，不能改成不兼容的普通业务 JSON。
需要保留并能正确获取以下信息：

| 类别 | 必需字段 |
| --- | --- |
| 标识与引用 | StudyInstanceUID、SeriesInstanceUID、SOPInstanceUID、SOPClassUID、FrameOfReferenceUID |
| 几何 | Rows、Columns、ImagePositionPatient、ImageOrientationPatient、PixelSpacing |
| 像素解释 | BitsAllocated、BitsStored、HighBit、PixelRepresentation、SamplesPerPixel、PhotometricInterpretation |
| CT 强度 | RescaleSlope、RescaleIntercept；原始值经过 rescale 得到 HU |
| 加载与排序 | TransferSyntaxUID、InstanceNumber、NumberOfFrames（适用时），及完整帧位置 |

不能仅返回截图或经过窗宽窗位处理的 PNG/JPEG。前端阈值操作需要原始强度和空间信息。
压缩 DICOM 的传输语法必须能被当前 Cornerstone 解码器读取；P0 联调可先使用未压缩单帧 CT。

切片顺序必须按空间位置确定：将 ImagePositionPatient 投影到切片法向量后排序。
不能只按文件名、上传顺序或 InstanceNumber 排序。`SliceThickness` 不能直接代替实际层间距。
缺片、不规则层距、重复位置或方向不一致时，需要明确标记不满足三维重建条件；不能伪造等间距几何。
P0 不处理 Enhanced CT 多帧、动态体数据或跨序列合并；这些数据应明确提示不支持相应全局操作。

### 2.2 影像上传与入库

推荐业务入口：`POST /api/v1/dicom/imports`，`multipart/form-data`，同名 `files` 字段重复上传 `.dcm` 文件。
返回 `202` 和导入任务 ID，通过 `GET /api/v1/dicom/imports/{importId}` 查询。
后端可将文件转交给 PACS 的 STOW-RS，再查询入库结果。

- 任务状态：`queued → running → completed / partial / failed`。
- 返回已处理数、失败文件、错误原因，以及成功入库的 Study / Series UID；成功的序列随后必须能被 QIDO / WADO 读取。
- 一次上传可以包含多个序列，按 DICOM UID 分组，不把不同序列拼成一个体。
- 同一 SOPInstanceUID、相同文件哈希重复上传，报告 `duplicate`，不创建重复实例。
- 同一 SOPInstanceUID、不同内容，报告 `UID_CONTENT_CONFLICT`，不静默替换原文件。
- 任务 GET 本身返回 `200`；单个文件冲突或解析失败记录在任务结果中。
- 非 DICOM 或无法解析的文件需返回明确的文件级错误。P0 上传大小限制需在服务配置与联调环境中公布；超限返回 `413`。
- 原始文件不可随标注修改而改写。P0 不要求 ZIP 解压、断点续传或分片上传。

若团队已有可供前端直接调用的 STOW-RS，可复用 `POST /dicomweb/studies`，
使用 `multipart/related; type="application/dicom"`。此时可省略导入任务门面接口，但前端上传适配和错误反馈需按 STOW 响应实现。
不要把 `multipart/form-data` 直接发送给只接受 STOW-RS 的地址。

## 3. 标注保存的数据约定

### 3.1 标识与范围

- 一个 `annotationSetId` 对应一个原始静态 Series，以及其中的一组 Mask；由后端生成业务 ID。
- 同一 Series 可有多个标注集，列表接口必须返回各自 ID，前端不能默认覆盖第一份。
- `segmentIndex` 是同一标注集中的 Mask 标签值。本期支持 `1..254`，`0` 表示背景，`255` 由当前 SDK 临时预览使用，禁止持久化。
- OHIF 的 `segmentationId`、`imageId`、`volumeId`、`dicomfile:` URL 是运行时标识，不能充当持久化 DICOM 引用。
- Mask 已删除、为空、隐藏、锁定是不同状态。空 Mask 仍可保留名称和颜色，隐藏或锁定不删除像素。

### 3.2 保存格式：DICOM SEG + JSON 元数据

P0 保存**完整标注快照**。像素使用二值 DICOM SEG 文件，名称、精确 RGBA、显隐、锁定等应用状态放在 JSON 中，
一起提交、一起生成新版本。不按鼠标轨迹保存，不把截图当作标注，不要求后端执行画笔算法。

| 字段 | 约定 |
| --- | --- |
| `schemaVersion` | 当前固定 `1` |
| `baseRevision` | 当前已加载的服务端版本，首次保存为 `0` |
| `sourceFingerprint` | 创建标注集时后端给出的不透明源数据指纹，保存时原样带回 |
| `contentKind` | `dicom-seg` 或 `empty` |
| `label` | 标注集名称 |
| `status` | `draft` 或 `completed`，默认草稿；不代表多人审核 |
| `segments[]` | 当前所有 Mask 的完整元数据，非局部 PATCH |
| `segments[].segmentIndex` | 当前 Labelmap 标签值，不重复 |
| `segments[].dicomSegmentNumber` | 对应 SEG 的 SegmentNumber；无体素的 Mask 为 `null` |
| `segments[].label` | Mask 名称 |
| `segments[].color` | `[r,g,b,a]`，四个 `0..255` 整数；恢复时优先使用 JSON，避免 CIELab 转换产生颜色误差 |
| `segments[].visible / locked` | 布尔值，恢复到切片与三维预览 |

`contentKind=dicom-seg` 时必须上传 SEG 文件，且至少有一个非空 Mask。
SEG 内的 SegmentNumber 与 JSON 中非空 Mask 的 `dicomSegmentNumber` 必须一一对应；
导出器若重排了 SegmentNumber，前端必须记录映射，不能假设它总等于 `segmentIndex`。
恢复时按映射写回 Labelmap 标签，SEG 不包含的空 Mask 从 JSON 重建。

`contentKind=empty` 表示整份选区为空，不上传 SEG 文件；`segments` 可以为空，也可仅包含空 Mask，
每个 `dicomSegmentNumber` 均为 `null`。这是明确清空当前标注的快照，不能当成“沿用上一版像素”。

**当前已补齐 Stack / MPR 的可靠 SEG 文件导出及逐帧验证，仍未完成这套快照联调。**
`extensions/cornerstone-dicom-seg/src/utils/prepareSegmentationExport.ts` 已处理 SDK 帧解析、源帧补载、
临时预览标签校验和与 dcmjs 一致的几何排序，接入保存时可复用；不要假设 `Labelmap.imageIds` 总是存在。
还需完成空 Mask 侧车、编号映射、状态恢复及再次保存。当前 dcmjs 的嵌套序列字符集继承读取存在问题，
恢复时需单独验证中文名称；不能将“UTF-8 导出字节正确”当成“名称往返已完成”。
后端可使用 DICOM 库校验 SEG；不能仅以扩展名判断上传合法。

### 3.3 几何与源数据绑定

创建标注集时，后端从已入库的原始序列生成只读 `source`，返回：

```json
{
  "studyInstanceUID": "2.25.10001",
  "seriesInstanceUID": "2.25.10002",
  "frameOfReferenceUID": "2.25.10003",
  "fingerprint": "opaque-source-fingerprint",
  "coordinateSystem": "LPS",
  "dimensions": [128, 128, 2],
  "spacing": [1, 1, 2],
  "origin": [0, 0, 0],
  "direction": [1, 0, 0, 0, 1, 0, 0, 0, 1],
  "reconstructable": true,
  "frames": [
    { "index": 0, "sopInstanceUID": "2.25.20001", "frameNumber": 1 },
    { "index": 1, "sopInstanceUID": "2.25.20002", "frameNumber": 1 }
  ]
}
```

这是一个两层序列的示例，不是仓库合成数据的 UID。
尺寸顺序为 `[columns, rows, slices]`；spacing 顺序为 `[x,y,z]`，单位 mm；origin 为第一个体素中心的 LPS 坐标。
`direction` 按九个数保存，依次为 x、y、z 三根索引轴在 LPS 下的单位向量，
即 `world = origin + x*spacing[0]*direction[0:3] + y*spacing[1]*direction[3:6] + z*spacing[2]*direction[6:9]`。
`frames` 按上述几何顺序列出，`index` 从 0 开始，DICOM `frameNumber` 从 1 开始。

不可重建的 P0 序列仍可进行切片级标注；此时 `reconstructable=false`，`spacing / origin / direction` 为 `null`，
逐帧几何通过 DICOM 元数据读取，不能对该序列宣称支持三维全局处理。

后端在提交 SEG 时校验它引用本标注集固定的原始 Study、Series、SOP 帧及 FrameOfReferenceUID。
SEG 自身应有新的 SeriesInstanceUID 和 SOPInstanceUID，不能覆盖原始 CT。
非空 SEG 可只存实际有标注的帧，未出现的源帧恢复为背景；恢复后仍必须建立完整源序列的 Mask。
指纹由后端根据不可变源数据生成，前端不自行推算。保存时不允许静默换源、重排切片或重采样。

## 4. 业务接口清单

基础路径 `/api/v1`。JSON 使用 UTF-8；时间使用含时区的 ISO 8601 UTC 字符串。
下列 P0 接口的请求和响应结构以配套 OpenAPI 为准。

| 方法与路径 | 用途 | 成功状态 |
| --- | --- | --- |
| `GET /api/v1/health` | 查看后端版本及 DICOM 服务可用性 | `200`，依赖不可用为 `503` |
| `POST /api/v1/dicom/imports` | 上传原始 DICOM，创建入库任务 | `202` |
| `GET /api/v1/dicom/imports/{importId}` | 查询导入进度与按序列分组结果 | `200` |
| `POST /api/v1/annotation-sets` | 用 Study / Series UID 创建草稿，返回固定源数据、revision=0 | `201` |
| `GET /api/v1/annotation-sets?studyInstanceUID=...&seriesInstanceUID=...` | 查询原始序列的标注集，支持 limit / cursor | `200` |
| `GET /api/v1/annotation-sets/{annotationSetId}` | 读取当前完整快照、源数据和 SEG 下载地址 | `200` |
| `PUT /api/v1/annotation-sets/{annotationSetId}/snapshot` | 完整保存 JSON 与 SEG；`multipart/form-data` | `200` |
| `GET /api/v1/annotation-sets/{annotationSetId}/revisions/{revision}/segmentation` | 下载某个已提交版本的 SEG，`application/dicom` | `200`，空快照为 `404` |

保存请求的 multipart 字段：`metadata` 为 `application/json`，`segmentation` 为 `application/dicom` 文件。
浏览器使用 `FormData`，不要手写丢失 boundary 的请求 Content-Type。
`Idempotency-Key` 请求头在保存接口必填；同一请求重试使用同一个值。

示例 `metadata`：

```json
{
  "schemaVersion": 1,
  "baseRevision": 0,
  "sourceFingerprint": "opaque-source-fingerprint",
  "contentKind": "dicom-seg",
  "label": "骨组织标注",
  "status": "draft",
  "segments": [
    {
      "segmentIndex": 1,
      "dicomSegmentNumber": 1,
      "label": "骨组织",
      "color": [255, 80, 80, 255],
      "visible": true,
      "locked": false
    }
  ]
}
```

保存响应包含 `id`、递增后的 `revision`、`updatedAt`、固定 `source`、完整 `snapshot`，
以及非空快照的 `artifact`：`url / mediaType / sha256 / sizeBytes`。
读取接口返回同样的资源结构；创建时 `snapshot` 和 `artifact` 为 `null`。
响应中 `snapshot.baseRevision` 是这份快照保存时的父版本；下一次保存必须使用外层 `revision` 作为新的 `baseRevision`。
`artifact.url` 必须绑定具体 revision，禁止用会指向新版本的裸 `latest` URL；校验和针对实际下载文件的字节。

### 4.1 原子保存、重试和版本号

1. 校验 `baseRevision`、源数据指纹、元数据和 SEG 引用，文件持久化成功后再原子更新版本指针。
2. 只有整个快照成功后返回 `200`；超时、存储失败、格式错误时旧版本仍可完整读取。
3. `baseRevision` 落后返回 `409 REVISION_CONFLICT` 和 `currentRevision`，不覆盖新版本。
   这用于防止同一人的两个标签页覆盖，不引入多人协作机制。
4. `Idempotency-Key` 按“当前用户 / 标注集 / 请求内容”处理。已成功的同一次请求重试，返回原保存结果，
   不重复递增版本；必须先判断幂等重放，再判断旧 baseRevision。
   同一 key 配不同内容返回 `409 IDEMPOTENCY_KEY_REUSED`。保存 key 至少保留 24 小时。
5. 快照替换覆盖本标注集全部 Mask，像素与 JSON 不能分别更新成功。
6. 刷新后需要恢复标注结果，但不要求恢复之前的逐笔撤销栈；本期撤销重做仍属于前端会话。

### 4.2 错误返回

业务错误统一结构，DICOMweb 继续使用其标准错误响应：

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "标注已有新版本，请重新加载后再保存。",
    "requestId": "req-example",
    "currentRevision": 4,
    "details": []
  }
}
```

| HTTP | 常见业务 code |
| --- | --- |
| `400` | `INVALID_ARGUMENT`、缺少幂等 key 或 multipart 字段 |
| `401 / 403` | 沿用团队现有登录鉴权；若启用鉴权，业务与 DICOM 请求都必须可携带同一会话 |
| `404` | `NOT_FOUND`、`EMPTY_SNAPSHOT`（该版本没有 SEG 文件） |
| `409` | `REVISION_CONFLICT`、`IDEMPOTENCY_KEY_REUSED` |
| `413 / 415` | `PAYLOAD_TOO_LARGE`、`UNSUPPORTED_MEDIA_TYPE` |
| `422` | `SOURCE_MISMATCH`、`INVALID_SEGMENTATION`、`UNSUPPORTED_GEOMETRY` |
| `503` | `DICOM_SERVICE_UNAVAILABLE`、`STORAGE_UNAVAILABLE` |

`details` 可包含 `field` 和 `message`，方便前端定位哪一个 Mask 或引用有问题。
业务接口不要在 HTTP 200 中放置一个失败标记来替代这些状态码。

## 5. 前端接入位置与待办

当前配置为 `platform/app/public/config/mask-demo.js`，仅配置 `dicomlocal`，无后端 URL。
联调时新增独立配置，保留本地演示。可参考仓库 `platform/app/public/config/local_orthanc.js`
和 `dicomweb_relative.js`，将 OHIF `qidoRoot` 与 `wadoRoot` 指向 `/dicomweb`，
`imageRendering` 与 `thumbnailRendering` 使用 `wadors`。业务保存 API 另配置 `/api/v1`。
仅修改 dataSource 配置不会自动获得本文的快照保存功能。

| 前端代码位置 | 接入用途 |
| --- | --- |
| `extensions/cornerstone/src/panels/MaskEditingTools.tsx` | 工作台与操作反馈；后续增加保存状态入口 |
| `extensions/cornerstone/src/panels/PanelSegmentation.tsx` | Mask 名称、颜色、显隐、锁定的读取与恢复 |
| `extensions/cornerstone/src/services/SegmentationService/SegmentationService.ts` | 创建和恢复 Labelmap、全视图颜色与显隐 |
| `extensions/cornerstone-dicom-seg/src/commandsModule.ts` | 原生 SEG 生成 / 下载入口，需要补齐体数据和快照适配 |
| `extensions/cornerstone/src/utils/maskEditing/` | 当前前端算法与原子撤销，继续复用 |

前端后续实现顺序：选定服务端原始 Series → 创建 / 读取标注集 → 全量快照上传 → 重新加载 SEG 与 JSON → 再编辑保存。
本地文件导入后若要远端保存，先上传同一批原始 DICOM，确认所有源实例已可检索，再创建标注集。
不能只上传 Mask，让后端猜测它引用哪个序列。

自动保存建议在显式保存闭环通过后接入：编辑后 debounce，同一标注集串行提交；
提交时复制一致的像素与元数据快照。请求期间的新编辑继续标记为未保存，旧响应不能清除后续 dirty 状态。
网络失败保留本地选区并显示“未保存 / 重试”；不能在请求发出时就显示“已保存”。

若跨域，业务服务需要正确响应 OPTIONS；允许 Content-Type、Authorization（使用时）、Idempotency-Key，
允许对应 GET / POST / PUT 方法。DICOM 服务需允许客户端协商 Accept、获取 multipart 帧；
有 cookie 时显式配置允许的 Origin 与 credentials，不能组合通配符 Origin 与凭据。
优先同源反向代理，避免两套跨域配置。

## 6. 小组验收清单

1. 上传仓库生成的 8 张合成 DICOM；QIDO 能查到完整序列，WADO 元数据、帧及原文件可读取。
   重复上传不重复入库，错误文件能定位原因。
2. 从 DICOMweb 打开，与本地导入得到相同 HU 阈值结果，三维几何与切片顺序一致。
3. 两个以上 Mask 完成阈值、区域生长、填洞、拆分和手工编辑，保存成功后刷新页面重新打开。
4. 恢复后的每张切片 Mask 像素、Mask 编号映射、名称、RGBA、显隐、锁定与保存前一致；
   在恢复结果上仍可继续编辑并保存下一版。
5. 专门验证“只有空 Mask”“所有 Mask 删除”“非空与空 Mask 混合”“隐藏 Mask”“锁定 Mask”。
6. 在 MPR 编辑后保存，再恢复到四视图，轴向 / 冠状 / 矢状 / 3D 位置对应；保存不能只包含当前切片。
7. 保存请求中断后旧快照仍可下载；同 key 重试只生成一个版本；旧 revision 保存返回 409。
8. 将 SEG 引用替换成另一序列、错层或临时预览值 255，返回明确校验错误，不覆盖已有快照。
9. 后端交付接口地址、可用数据 UID、上传限制、启动方式和可运行样例；前端完成上述端到端验证后，
   再把“草案 / 待接入”状态更新为实际已实现范围。

P1 再扩展历史版本浏览、恢复旧快照（产生新 revision）、删除和多种导出格式。
服务器端三维算法、分块存储和增量保存应在真实数据规模验证后单独设计，不作为本次基础保存闭环的前置条件。
