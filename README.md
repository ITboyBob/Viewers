# Cloud Marker：基于 OHIF 的协作标注工程

本仓库是 [OHIF Viewers](https://github.com/OHIF/Viewers) 的业务改造 fork，包含影像工作台前端与 Java Spring Boot 后端。接手开发时，请先区分**已经实现的运行期文件／成果存取**、**浏览器本地光标共享**和**尚未实现的服务器实时共同编辑**。

本文按 2026 年 11 月 5 日、代码基线 `7619490fb` 整理。接口说明来自当前源码的静态对照，不表示四份原设计已全部实现，也不表示已完成生产部署或全量回归验证。

- [1. 项目简介与代码导航](#1-项目简介与代码导航)
- [2. 当前实现了什么、没有实现什么](#2-当前实现了什么没有实现什么)
- [3. 本地前后端启动](#3-本地前后端启动)
- [4. 新增接口与数据模型](#4-新增接口与数据模型)
- [5. 现有数据库接口说明](#5-现有数据库接口说明)
- [6. 如何接手服务器同步改造](#6-如何接手服务器同步改造)
- [7. 上游项目与许可证](#7-上游项目与许可证)

## 源分支掩膜工具参考

本次同步引入源分支的掩膜工作台、项目文件、三维精修、空腔填充和多关键层插值能力。
使用说明见 [掩膜演示说明](MASK_DEMO_README.md)、[项目工作流](PROJECT_WORKFLOW_NOTES.md)、
[三维精修](MASK_REFINEMENT_NOTES.md)、[三维填洞](CAVITY_FILL_NOTES.md) 和 [多关键层插值](INTERPOLATION_NOTES.md)。
源分支的 [后端需求草案](BACKEND_API_REQUIREMENTS.md) 与 [OpenAPI 草案](docs/mask-backend.openapi.yaml)
仅作来源参考，不替代下文的本项目业务接口与实现状态说明。

## 1. 项目简介与代码导航

当前业务入口围绕账号、团队、任务、本地 DICOM 导入及标注工作台展开；OHIF 继续承担影像显示与原生测量、分割等交互。本地 DICOM 启动配置不依赖 PACS，但业务功能需要同时启动本仓库后端。

| 位置 | 用途 |
| --- | --- |
| [platform/app/src/routes](platform/app/src/routes) | 账号、团队工作台、本地导入与共享页面 |
| [platform/app/src/business](platform/app/src/business) | 业务 API、会话、任务、存储、自动保存与协作装配 |
| [platform/core/src/types/BusinessContracts.ts](platform/core/src/types/BusinessContracts.ts) | 前端业务端口、生命周期和本地协作消息契约 |
| [extensions/cornerstone/src](extensions/cornerstone/src) | 原生视口、光标投影、成果采集与恢复适配 |
| [backend/phase-one](backend/phase-one) | Java 21、Spring Boot 3.5.7、JDBC 与 H2 后端 |
| [backend/phase-one/src/main/resources/db](backend/phase-one/src/main/resources/db) | 当前运行期表结构与增量 SQL |
| [platform/app/public/config/mask-demo.js](platform/app/public/config/mask-demo.js) | 启用业务功能的本地 DICOM 配置 |
| [MASK_DEMO_README.md](MASK_DEMO_README.md) | Mask 工具演示的补充说明；业务启动以本文为准 |

推荐阅读顺序：第 2 节了解能力边界 → 第 3 节启动 → 第 4 节了解接口差异 → 第 5、6 节分别接手数据库与服务器同步。

## 2. 当前实现了什么、没有实现什么

| 领域 | 当前实现了什么 | 当前没有实现什么 |
| --- | --- | --- |
| 账号与团队 | 注册／登录／注销、注册时创建自有团队、成员查询、当前团队选择、团队邀请与邀请通知 | 通用用户资料／密码管理、任意创建或编辑团队、成员移除／退出、角色调整与所有权转移 |
| 任务工作台 | 团队任务、最近访问、访问记录、导入登记、幂等重试、导入者更新时间 | 完整任务分配、业务状态流转、进度汇总、提交审核与返工 |
| 文件与成果 | 上传成功导入的源文件、运行期读取材料／源文件、成果快照提交与读取、修订冲突检查 | 跨后端进程的数据恢复、长期版本历史、完整 PACS／DCM4CHEE 数据集接入 |
| 标注工作台 | OHIF 原生工具；已存储的 `segmentation/dicomlocal` 任务接入自动保存与恢复；前端生成只读封面 | 对所有 OHIF 模式的自动保存保证、完整 `Mark/MarkRevision` 实体接口 |
| 本地协作 | 同源、同一浏览器存储分区内，通过 BroadcastChannel 与 IndexedDB 共享文件、参与状态和光标；光标投影按当前 stack 视口的同一影像帧匹配 | 跨浏览器配置／设备的服务器光标同步、服务器在线成员服务、标注／测量内容的实时增量共同编辑 |
| 工作台协作邀请 | 按真实用户名邀请；通知、标读、接受／拒绝；独立任务授权；接受后加载原工作台，不入队或切队 | 接受后改权、重复邀请、撤权管理、跨实例授权恢复 |
| 权限 | 业务 Bearer 会话、团队／独立工作台资格、导入记录归属、定向新增分割限制 | 原设计完整权限字典、全部角色模板、完整只读授权管理流程 |

特别注意：

- **“仅查看”只限制 Add Segmentation 对应的新 segmentation 实体，不等于全局只读。**既有分割编辑、添加 segment、其他原本允许的工具和成果保存不因此受限；原本独立的任务只读及修订冲突规则仍然有效。
- **“成果已保存”不等于“其他客户端已实时收到修改”。**当前成果清单有修订检查，但没有配套的服务器实时广播与合并协议。
- 当前后端已保存运行期材料与成果，不能再将它描述为“只保存任务时间”；但也不能描述为可跨进程恢复的持久化系统。
- 团队成员列表、任务成员投影和浏览器本地在线参与者是三种不同对象，不能相互替代。
- H2 是临时工程方案。当前进程运行期间的可用性不代表数据能跨后端重启保留。
- 尚未实现项是交接边界，不是本文新增的开发承诺。

## 3. 本地前后端启动

### 3.1 环境与依赖

以下命令按 macOS／Linux shell 编写；Windows PowerShell 需要改用对应的环境变量设置语法，启动脚本与配置含义不变。

建议使用下列工具链。首次安装前端依赖或启动后端时，需要能够访问相应的软件仓库以下载依赖。后端固定使用 `dcm4che-core 5.33.1`，从 [dcm4che Maven 仓库](https://www.dcm4che.org/maven2) 下载，仅用于读取原图的分割身份元数据，不引入 DCM4CHEE 服务或像素解码器。

| 工具 | 要求 |
| --- | --- |
| Node.js | 根包要求 18 及以上，推荐使用 24 LTS |
| Yarn | Classic 1.22.22，与根包 `packageManager` 一致；不要改用 npm 或 Yarn Berry 重建依赖 |
| Java | JDK 21，须让 Maven 实际使用该版本 |
| Maven | 推荐 3.9.x，仓库没有 Maven Wrapper |
| 浏览器 | 支持 WebGL、BroadcastChannel、IndexedDB 的现代浏览器；本地共享需处于同源及相同存储分区 |

在仓库父目录执行，作用：进入本仓库；后续命令均以仓库根目录为工作目录。

```sh
cd OHIF-fork
```

作用：确认前后端工具链版本；尤其检查 `mvn -version` 中实际使用的 Java。

```sh
node --version
yarn --version
java -version
mvn -version
```

将 `JAVA_HOME` 指向 JDK 21 的安装目录，并将其 `bin` 与 Maven 的 `bin` 加入 `PATH`；具体路径按开发者各自的安装位置配置。无需额外启动 MySQL、H2 服务或 PACS。

作用：安装前端工作区依赖，并按锁文件及 `postinstall` 应用仓库中的依赖补丁；已安装且未变化时可以跳过。

```sh
yarn install --frozen-lockfile
```

### 3.2 启动真实后端

在终端 A、仓库根目录执行。作用：编译并启动 Spring Boot 后端；首次运行会下载 Maven 依赖。

```sh
mvn -B -f backend/phase-one/pom.xml spring-boot:run
```

- 默认地址：[http://127.0.0.1:8081](http://127.0.0.1:8081)。该端口是 API 服务，不是前端页面。
- 健康检查地址：[http://127.0.0.1:8081/actuator/health](http://127.0.0.1:8081/actuator/health)。
- 配置入口：[application.yml](backend/phase-one/src/main/resources/application.yml)。数据库为进程内 H2，H2 控制台关闭。
- 没有预置业务账号，首次使用通过前端注册。后端重启后需重新注册；不要使用真实患者数据做开发演示。

### 3.3 启动真实前端

保持后端运行，另开终端 B，在仓库根目录执行。作用：启用本地 DICOM 与业务功能配置，启动前端，并关闭自动打开浏览器。

```sh
OHIF_OPEN=false yarn dev:mask
```

该命令等价于使用 `APP_CONFIG=config/mask-demo.js` 启动现有 webpack 开发服务；并非单独的静态页面或业务 mock 服务。首次编译可能较慢，应等待 webpack 完成编译后访问。

| 页面 | 默认地址 |
| --- | --- |
| 登录入口 | [http://localhost:3000/account/login](http://localhost:3000/account/login) |
| 注册入口 | [http://localhost:3000/account/register](http://localhost:3000/account/register) |
| 团队任务 | [http://localhost:3000/team/tasks](http://localhost:3000/team/tasks) |
| 最近访问 | [http://localhost:3000/team/recent](http://localhost:3000/team/recent) |
| 本地 DICOM 导入 | [http://localhost:3000/local-mask](http://localhost:3000/local-mask) |

未登录访问受保护入口会进入账号门禁。浏览器业务请求使用同源 `/api/v1`；webpack 默认将 `/api/v1` 和 `/actuator/health` 代理到 `http://127.0.0.1:8081`，无需在页面代码中改后端地址。业务 Token 保存在当前标签页的 sessionStorage，与 OHIF OIDC／PACS 认证分离。

不要把 `dev:fast`、原始默认配置或 E2E 专用配置当作上述启动方式的等价替代，它们的代理／业务开关可能不同。工作台协作邀请和团队邀请均已接入真实服务；浏览器本地文件／光标共享仍是独立链路，不能据此声称已经有服务器实时共同编辑。

### 3.4 端口与停止方式

如默认端口被占用，不要直接终止未知进程。下面是可选替代，不要与默认启动命令重复执行。

作用：在终端 A 将后端端口改为 18081。

```sh
SERVER_PORT=18081 mvn -B -f backend/phase-one/pom.xml spring-boot:run
```

作用：在终端 B 将前端端口改为 3336，并把业务代理指向对应后端；此时登录地址为 [http://localhost:3336/account/login](http://localhost:3336/account/login)。

```sh
OHIF_PORT=3336 COLLA_API_TARGET=http://127.0.0.1:18081 OHIF_OPEN=false yarn dev:mask
```

停止时分别在两个服务终端按 `Ctrl+C`。后端退出会失去本次运行的数据；再次启动不会恢复上次的账号、材料或成果。浏览器中遗留的会话／本地缓存不能替代后端数据与鉴权。以上是本地开发服务，不是生产部署方案。

## 4. 新增接口与数据模型

对照基准是 `api.md`、`model.md`、`permission.md`、`task-management.md` 四份原设计文档。它们当前不随本 fork 分发，因此下文直接概述关键差异，不依赖开发者电脑上的路径。四份文档不等于第一阶段交付范围；原文中的建议、暂缓项和当前代码应分别理解。

本节接口均以 `/api/v1` 为前缀，表中省略前缀。JSON 单资源通常包裹在 `data`；成员／邀请分页使用 `{data,meta}`，工作台任务列表则为 `{data:{items,total,mock:false}}`，不能假定所有列表结构相同。业务错误为 `{error:{code,message,details}}`；文件响应直接返回二进制，`204` 无响应体。除注册、登录及允许匿名调用的注销外，业务接口需要 Bearer Token；有 Token 也不免除资源级校验。

### 4.1 注册、认证会话与当前团队

对照：`api.md` §2～3、`model.md` §1～3、`permission.md` §5.1。

| 类型 | 方法与路径 | 当前语义 |
| --- | --- | --- |
| 调整 | `POST /users` | 匿名注册，请求 `username/password`；事务内创建用户、自有团队与 owner 关系，再签发会话；不是通用管理员创建用户 |
| 保留并扩充 | `POST /auth/sessions`、`GET /auth/sessions/current` | 登录／查询会话；上下文含 `user/expires_at/default_team_id/memberships/selected_team_id`，签发响应另含 `token` |
| 保留并调整门禁 | `DELETE /auth/sessions/current` | 注销，返回 204；允许匿名请求，有可识别 Token 时撤销该会话 |
| 新增 | `PUT /auth/sessions/current/team` | 请求 `{team_id}`，校验成员关系后保存当前团队偏好，返回会话上下文 |

`User/Team/TeamMember` 的部分核心字段落地为 `app_user/team/team_member`；当前注册不接收原设计的 `email/avatar_url`，公开用户摘要仍有可为 null 的 `avatar_url`。新增密码摘要、会话及工作区偏好存储，不向前端返回密码摘要。当前成员角色限 `owner/annotator`；`team.owner_uid` 唯一，不能推定为任意用户可拥有任意多个团队。

源码入口：[IdentityDtos](backend/phase-one/src/main/java/cn/colla/phaseone/identity/IdentityDtos.java)、[RegistrationService](backend/phase-one/src/main/java/cn/colla/phaseone/identity/RegistrationService.java)、[AuthController](backend/phase-one/src/main/java/cn/colla/phaseone/auth/AuthController.java)、[SessionService](backend/phase-one/src/main/java/cn/colla/phaseone/auth/SessionService.java)。

### 4.2 团队成员、邀请与通知

对照：`api.md` §5、`model.md` §3、`permission.md` §5.2。原设计通过 `POST /teams/{team_id}/members` 直接创建成员；当前采用独立邀请资源，原入口及任意角色授予没有落地。

| 类型 | 方法与路径 | 关键输入／输出 |
| --- | --- | --- |
| 保留并具体化 | `GET /teams/{teamId}/members` | `page/page_size` 分页；成员含 `uid/username/avatar_url/role/joined_at` |
| 新增 | `POST /teams/{teamId}/invitations` | 请求 `{username}`，返回邀请；任一有效团队成员可发送，不采用原设计的 `team.manage` 门禁 |
| 新增 | `POST /invitations/{id}/accept`、`POST /invitations/{id}/reject` | 仅接收者处理；不带请求体或查询参数，返回邀请结果 |
| 新增 | `GET /teams/{teamId}/invitations/sent` | 分页返回本人发送且尚未到期的记录；`meta.server_time` 用于期限判断，不只返回 pending 记录 |
| 新增 | `GET /notifications/team-invitations` | 当前接收者的分页邀请通知 |
| 新增 | `GET /notifications/team-invitations/unread-count` | 返回未读计数 |
| 新增 | `POST /notifications/team-invitations/read` | 请求 `{invitation_ids}`，按接收者校验并标记已读 |

新增 `team_invitation`：关联团队、发送者与接收者；`decision` 为 `pending/accepted/rejected`，另有 `decided_at/expires_at/read_at/invalidated_at`。已读、决定、过期和失效不是同一状态。邀请有效期 300 秒；相同团队、发送者、接收者的期限记录形成冷却窗口，接受或拒绝不会立即解除。接收者必须是已有有效账号，不能邀请自己或已有成员；接受后固定为 annotator，并使同团队同接收者的其他有效待处理邀请失效。

源码入口：[InvitationController](backend/phase-one/src/main/java/cn/colla/phaseone/invitation/InvitationController.java)、[InvitationDtos](backend/phase-one/src/main/java/cn/colla/phaseone/invitation/InvitationDtos.java)、[InvitationService](backend/phase-one/src/main/java/cn/colla/phaseone/invitation/InvitationService.java)、[NotificationReadService](backend/phase-one/src/main/java/cn/colla/phaseone/invitation/NotificationReadService.java)。

#### 工作台协作邀请（已实现）

与上面的入队邀请独立：目标为原 `task_id`，不会添加 `team_member` 或更改当前团队。任何具有目标工作台合法访问资格的用户都可邀请，包括已授权的非团队协作者。

| 方法与路径 | 输入／输出与作用 |
| --- | --- |
| `POST /tasks/{taskId}/collaboration-invitations` | `{username,permission:"edit"或"view"}`；201 返回真实邀请 |
| `GET /tasks/{taskId}/collaboration-invitations/sent` | 本人尚在原五分钟期限内的发送记录；含已接受／拒绝记录及 `meta.server_time` |
| `GET /notifications/collaboration-invitations` | 当前收件人的分页协作通知 |
| `GET /notifications/collaboration-invitations/unread-count` | 当前收件人的未读数 |
| `POST /notifications/collaboration-invitations/read` | `{invitation_ids}`；独立、幂等标读 |
| `POST /collaboration-invitations/{id}/accept` | `{data:{invitation,task_id,mode_path}}`；授权与接受原子确认 |
| `POST /collaboration-invitations/{id}/reject` | `{data:invitation}`；不建立授权 |

邀请含工作台名称、真实发起人和收件人摘要、`permission/decision/created_at/expires_at/decided_at/read_at`。同一发起人、任务与收件人的五分钟防重不因处理或刷新提前解除；不同发起人的记录独立。首次接受必须在期限内，成功接受后重复接受同一邀请幂等，原期限到达不撤销授权。已有 `(task_id,uid)` 授权时再次邀请或接受另一份邀请返回 `409 / ALREADY_COLLABORATOR`，不改权、不重复通知。通知不显示权限；接受成功但加载失败保留接受结果，可重试进入，不重复接受。

源码入口：[CollaborationController](backend/phase-one/src/main/java/cn/colla/phaseone/collaboration/CollaborationController.java)、[CollaborationService](backend/phase-one/src/main/java/cn/colla/phaseone/collaboration/CollaborationService.java)、[CollaborationInvitationService](platform/app/src/business/CollaborationInvitationService.ts)。

### 4.3 团队工作台、任务登记与访问记录

对照：`api.md` §6～7、`model.md` §4～5、`task-management.md` §4～7。

| 类型 | 方法与路径 | 当前语义 |
| --- | --- | --- |
| 调整 | `GET /teams/{teamId}/tasks` | 返回团队任务卡片；创建时间倒序及 ID 稳定排序；未实现原设计的分页和状态／分配人／数据集过滤 |
| 调整 | `POST /teams/{teamId}/tasks` | 请求 `title` 与可省略的空 `metadata`，必需 UUID 格式 `Idempotency-Key`；首次 201，一致重放 200 |
| 新增 | `GET /tasks/recent` | 当前用户访问记录，仍受团队成员资格过滤 |
| 新增 | `POST /tasks/{taskId}/visits` | 记录 `last_entered_at`，返回 204；不改变任务标注更新时间 |
| 新增 | `GET /tasks/{taskId}/members` | 当前只读投影仅含导入者，不是分配名单或实时在线名单 |
| 新增 | `PATCH /teams/{teamId}/tasks/{taskId}/updated-at` | 请求必须是 `{}`，仅导入者可调用；返回 `task_id/updated_at` |

当前 `task_record` 含 `task_id/team_id/title/assignee_uid/metadata/created_at/updated_at`，没有原 Task 的 `status/dicom_dataset_ids`。`assignee_uid` 由服务端取当前登录者，语义是导入者，不是 TaskAssignment。新增 `task_registration` 处理登记幂等、`task_visit` 处理用户访问历史。

正常前端已装配存储服务，优先走下一节的文件导入链路；直接任务登记是保留入口及无存储服务时的分支，不是唯一主路径。浏览器 `LocalProject.phase` 只是页面生命周期，不是任务业务状态。TaskAssignment、任务完成规则、进度汇总尚未落地；原需求中的状态／审核建议也不能据此变成冻结契约。

源码入口：[TaskService（前端）](platform/app/src/business/TaskService.ts)、[TaskController](backend/phase-one/src/main/java/cn/colla/phaseone/task/TaskController.java)、[DashboardService](backend/phase-one/src/main/java/cn/colla/phaseone/dashboard/DashboardService.java)、[任务表](backend/phase-one/src/main/resources/db/V003__tasks.sql)。

### 4.4 DICOM 文件导入、材料读取与运行期存储

对照：`api.md` §8、`model.md` §8、`task-management.md` §4.2。当前新增的是文件上传与任务材料模型，不是原设计的数据集检索接口。

| 方法与路径（均为新增） | 当前语义 |
| --- | --- |
| `POST /teams/{teamId}/task-imports` | 创建／复用导入记录，返回 `import_id/uploaded_files` |
| `PUT /task-imports/{id}/files/{file}` | 上传清单中指定源文件的原始二进制 |
| `POST /task-imports/{id}/complete` | 检查上传完整性，在事务中登记任务并关联材料，返回 Task |
| `GET /tasks/{id}/materials` | 返回 `{task,source,access}`；`access` 含 `owner_uid/can_edit/collaboration_permission/can_add_segmentation` |
| `GET /tasks/{id}/files/{file}` | 按团队资格或指定任务协作授权读取源文件二进制 |

导入请求含 `registration_key/title/kind/folder_name/mode_path/files`；文件描述含 `file_id/selection_index/file_name/relative_path/size/study_uid/series_uid/sop_uid`。`task_import` 保存导入归属与清单，`task_material` 保存任务材料及当前成果清单／修订。暂存上传与完成操作只允许导入记录的创建者执行，材料读取接受有效团队成员资格或后端独立工作台授权；后者不开放团队任务列表与团队成员管理。

后端检查字段、UID 格式、大小、上传完整性及字节哈希；新增的分割基线从实际原始 SEG／RTSTRUCT 解析 SOP 类别与 Study／Series／SOP UID，不相信客户端的“不是新增”声明。这是新增分割识别，不是对所有导入文件进行完整 DICOM 内容合规验证。当前没有 `DicomDataset/source_id` 资源映射、DCM4CHEE 检索及原设计的数据集授权模型；不能把 Study UID 或上传文件清单直接当作已实现的平台数据集 ID。

源码入口：[TaskStorageService（前端）](platform/app/src/business/TaskStorageService.ts)、[TaskStorageController](backend/phase-one/src/main/java/cn/colla/phaseone/storage/TaskStorageController.java)、[TaskStorageService（后端）](backend/phase-one/src/main/java/cn/colla/phaseone/storage/TaskStorageService.java)。

### 4.5 标注成果快照、修订与封面读取

对照：`api.md` §9 原为暂缓设计，`model.md` §6～7 仅保留 Mark／MarkRevision 草案。当前新增的是任务成果快照，不是该草案的完整实现。

| 方法与路径（均为新增） | 当前语义 |
| --- | --- |
| `GET /tasks/{id}/results` | 返回当前 `{revision,objects,access}` |
| `PUT /tasks/{id}/result-files/{object}` | 上传成果二进制 |
| `GET /tasks/{id}/result-files/{object}` | 读取当前已引用的成果文件 |
| `POST /tasks/{id}/results/commit` | 请求 `{base_revision,operation_id,objects:[{object_id,type}]}`，提交新的整份成果清单 |

`base_revision` 检查当前任务清单的并发修订，`operation_id` 与操作者／载荷约束重放；冲突不等于自动合并。`task_result_operation` 记录幂等载荷与响应，新修订替换当前清单，提交后清理不再引用的旧成果文件。这里的 `revision` 不是逐标注 MarkRevision，也没有长期历史版本查询接口。

`type` 可为 `SR/SEG/RTSTRUCT`，但实际字节是自定义业务成果包，不是标准 DICOM SR／SEG／RTSTRUCT 文件。包格式仍为 v1；分割条目增加稳定的 `entity_id`，原始分割采用 `dicom:<study_uid>/<series_uid>/<sop_uid>`，用户新建实体沿用 segmentation 标识，旧包缺省时回退到 `segmentationId`。运行时随机 displaySet 标识不会改变该业务身份。提交时遍历所有类型包内的实体并拒绝重复身份；仅查看者的新增实体返回 `403 / SEGMENTATION_CREATE_FORBIDDEN`，修订不变，合法保存不被永久封禁。更换上传对象 ID、重新编码、向已有分割添加 segment 均不直接等同于新增实体。自动保存当前装配在已存储的 `segmentation/dicomlocal` 分支；不能外推到所有模式。只读封面由前端读取材料、首个成功源文件及当前成果后局部合成，并复核修订；没有独立后端封面 API。

源码入口：[TaskAutoSave](platform/app/src/business/TaskAutoSave.ts)、[ProjectRuntimeService](platform/app/src/business/ProjectRuntimeService.ts)、[TaskResultCodec](extensions/cornerstone/src/utils/TaskResultCodec.ts)、[ReadonlyPreviewLoader](platform/app/src/business/ReadonlyPreviewLoader.ts)、[composeReadonlyPreview](platform/app/src/routes/Team/composeReadonlyPreview.ts)。

### 4.6 权限差异与尚未实现的原设计

对照：`permission.md` §2～5、`task-management.md` §3～7，并结合上述 API／模型差异。

- 当前 `SecurityConfig` 处理认证门禁，`TeamPolicy.requireMember` 检查有效账号和目标团队成员关系；没有通用的 21 项权限授权系统、manager／viewer 模板和按个人分配范围过滤。
- 有效团队成员可读取团队任务、材料和成果；非团队用户的独立协作授权只开放指定工作台的材料、文件、成果及必需辅助请求，不开放团队级列表与管理。`access.collaboration_permission` 为 `edit/view/null`，`can_add_segmentation` 由后端计算；`view` 不写成 `can_edit=false`。成果写入仍检查既有 `task_read_only`。当前未提供增删该只读记录的业务入口，不能描述为完整可操作的只读权限管理。窄更新时间接口则单独限制导入者，不能与成果写权限混为一谈。
- 尚未实现原设计的用户资料／密码／系统授权管理、通用团队 CRUD 与成员管理、通用任务详情／修改／删除、TaskAssignment、任务业务状态与进度、DicomDataset、Mark／MarkRevision 实体 CRUD 及长期版本历史。
- 浏览器本地 `join/state/heartbeat/cursor/leave` 是本地消息，不是 HTTP DTO 或 SQL 实体；当前业务源码没有服务器实时协作服务，也没有标注内容增量消息。
- `task-management.md` 中的流程建议不代表已实施；`api.md/model.md` 明确暂不加入的审核功能，也不能因为建议文档出现过就说成当前必备或已冻结能力。

源码入口：[SecurityConfig](backend/phase-one/src/main/java/cn/colla/phaseone/auth/SecurityConfig.java)、[TeamPolicy](backend/phase-one/src/main/java/cn/colla/phaseone/team/TeamPolicy.java)、[本地协作契约](platform/core/src/types/BusinessContracts.ts)。

## 5. 现有数据库接口说明

### 5.1 如何定位数据库访问链路

这里的“数据库接口”指现有服务端的数据访问入口，不是要求前端直接连接数据库。调用关系为：前端 BusinessApiClient／业务服务 → REST Controller → Service → Repository 或 Service 内 JdbcTemplate → H2。当前没有一套独立、可替换全部存储的统一 DAO 接口。

| 业务 | 数据访问入口 | 主要对象 |
| --- | --- | --- |
| 身份、团队与会话 | [IdentityRepository](backend/phase-one/src/main/java/cn/colla/phaseone/identity/IdentityRepository.java)、[SessionService](backend/phase-one/src/main/java/cn/colla/phaseone/auth/SessionService.java) | `app_user/team/team_member/auth_session/workspace_preference` |
| 邀请与通知 | [InvitationRepository](backend/phase-one/src/main/java/cn/colla/phaseone/invitation/InvitationRepository.java)、[NotificationReadService](backend/phase-one/src/main/java/cn/colla/phaseone/invitation/NotificationReadService.java) | `team_invitation` 及其决定、已读、期限和失效字段 |
| 任务登记与更新时间 | [TaskRepository](backend/phase-one/src/main/java/cn/colla/phaseone/task/TaskRepository.java)、[TaskRegistrationTransaction](backend/phase-one/src/main/java/cn/colla/phaseone/task/TaskRegistrationTransaction.java)、[TaskTouchService](backend/phase-one/src/main/java/cn/colla/phaseone/task/TaskTouchService.java) | `task_record/task_registration` |
| 工作台与访问历史 | [DashboardService](backend/phase-one/src/main/java/cn/colla/phaseone/dashboard/DashboardService.java)、[DashboardTargetResolver](backend/phase-one/src/main/java/cn/colla/phaseone/dashboard/DashboardTargetResolver.java) | `task_visit`、任务／团队成员的查询投影 |
| 文件与成果 | [TaskStorageService](backend/phase-one/src/main/java/cn/colla/phaseone/storage/TaskStorageService.java) | `task_import/task_material/task_result_operation/task_read_only`，另有临时文件与进程内 Blob 索引 |

### 5.2 表结构、关系与一致性边界

[application.yml](backend/phase-one/src/main/resources/application.yml) 按顺序加载以下 SQL；当前是 Spring SQL 初始化，不是已装配的 Flyway／Liquibase 迁移框架。

| 文件 | 内容 |
| --- | --- |
| [V001__identity.sql](backend/phase-one/src/main/resources/db/V001__identity.sql) | 用户、自有团队、成员与会话 |
| [V002__invitations.sql](backend/phase-one/src/main/resources/db/V002__invitations.sql) | 团队邀请 |
| [V003__tasks.sql](backend/phase-one/src/main/resources/db/V003__tasks.sql) | 任务与登记幂等 |
| [V004__task_visits.sql](backend/phase-one/src/main/resources/db/V004__task_visits.sql) | 用户与任务访问关系 |
| [V005__workspace_storage.sql](backend/phase-one/src/main/resources/db/V005__workspace_storage.sql) | 邀请已读、团队偏好、只读记录、材料与成果操作 |
| [V006__invitation_validity.sql](backend/phase-one/src/main/resources/db/V006__invitation_validity.sql) | 邀请失效与期限查询索引 |
| [V007__workspace_collaboration.sql](backend/phase-one/src/main/resources/db/V007__workspace_collaboration.sql) | 工作台协作邀请、独立授权、可信初始分割身份基线 |

需保留的关系与规则包括：一个用户的自有团队约束、团队与用户的复合成员键、登记键的用户作用域、访问记录的用户／任务作用域，以及任务与材料的一对一关系。`task_result_operation` 的任务／操作复合键服务于提交幂等，不是版本历史。

工作台协作授权使用 `(task_id,uid)` 唯一键，记录权限、来源邀请和接受时间，不设置邀请期限式的授权到期时间。协作邀请与首次接受使用任务行锁，接受状态和授权在同一事务确认；它不复用入队邀请增加成员的动作。

注册创建账号／团队／成员、接受入队邀请增加成员并使其他入队邀请失效、任务登记幂等、完成导入与成果提交都涉及现有事务或锁边界。修改时应沿 Service 的 `TransactionTemplate/@Transactional`、登记冲突处理和成果 `afterCommit` 文件清理继续追踪，不能只替换 SQL 连接地址。

### 5.3 当前 H2 与运行期文件限制

- 数据源为 `jdbc:h2:mem:`，账号、团队、会话、任务、协作邀请／授权及成果索引只属于当前后端进程；浏览器刷新或同一实例下的授权客户端可继续访问，但后端重启后不恢复。
- 原始 DICOM 与成果字节在后端临时目录，Blob 路径／哈希索引在进程内；正常销毁会清理临时文件，异常退出可能遗留文件，但这不是可恢复的数据存储。
- 默认容量限制为单文件 512 MiB、单次导入累计 2 GiB、运行期累计 16 GiB，入口为 `colla.storage.*`；不是正式生产存储容量承诺。
- 将 H2 改为文件模式或改用 MySQL，不会自动解决临时文件与 Blob 索引的恢复问题；不得据此宣称已经具备长期留存。

**MySQL 接入仅作为后续改造参考：**可从数据源配置、Maven 驱动依赖、建表类型与 SQL 方言、锁／事务／幂等语义开始评估。当前含 H2 的 `MERGE INTO`、JSON、CLOB、带时区时间等用法，不能视为只改 URL 即可迁移。本文不确定最终表设计、迁移工具、长期文件存储或上线方案，本次也不实际接入 MySQL。

## 6. 如何接手服务器同步改造

### 6.1 先理解现有链路

当前本地协作大致为：共享源身份与文件发布 → BroadcastChannel 加入握手 → 参与者快照／心跳／光标 → 视口显示。源页面与身份生命周期会影响本地共享资格；IndexedDB 文件缓存本身不授予访问资格。

| 入口 | 职责及接手位置 |
| --- | --- |
| [createBusinessServices.ts](platform/app/src/business/createBusinessServices.ts) | 装配业务会话、源／查看者参与服务、BroadcastChannel、文件缓存与共享视图，是替换本地传输的入口 |
| [BusinessContracts.ts](platform/core/src/types/BusinessContracts.ts) | `LocalChannelPort/LocalParticipationPort/LocalSharingMessage/SharedCursorPosition`；现有本地契约，不是已定服务器协议 |
| [LocalParticipationIdentity.ts](platform/app/src/business/localCollaboration/LocalParticipationIdentity.ts)、[SourceSessionVerifier.ts](platform/app/src/business/localCollaboration/SourceSessionVerifier.ts) | 参与者身份、会话变化与源端校验；不能把客户端判断替代成服务器授权 |
| [LocalParticipationService.ts](platform/app/src/business/localCollaboration/LocalParticipationService.ts) | 加入、快照、心跳、seq、光标节流与退出；可参考生命周期语义，但信任模型需重新设计 |
| [SharedFileStore.ts](platform/app/src/business/localCollaboration/SharedFileStore.ts)、[SharedFilePublisher.ts](platform/app/src/business/localCollaboration/SharedFilePublisher.ts)、[SharedViewService.ts](platform/app/src/business/localCollaboration/SharedViewService.ts) | IndexedDB 文件发布、共享加载和卸载；跨设备不能继续依赖同一浏览器文件缓存 |
| [RemoteCursorController.ts](extensions/cornerstone/src/Viewport/Overlays/RemoteCursorController.ts)、[remoteCursorProjection.ts](extensions/cornerstone/src/Viewport/Overlays/remoteCursorProjection.ts)、[RemoteCursorOverlay.tsx](extensions/cornerstone/src/Viewport/Overlays/RemoteCursorOverlay.tsx) | 指针采集、影像坐标与画布转换、同帧过滤、远端光标显示 |

现有光标含 `task_id` 上下文、参与者／源标识与 seq；位置含 `selection_index/study_uid/series_uid/sop_uid/frame_number`、`coordinate_space: image-pixel-center`、行列位置及影像尺寸。`frame_number` 从 1 开始。应保留影像坐标和帧身份，接收端按自身视口变换投影，而不是传输屏幕绝对像素。当前支持范围是同一原始帧的 stack 视口；不要未经设计就扩展到 MPR／3D。

### 6.2 光标与参与状态如何接入服务器

以下是接手参考，不是已确认的服务器协议或实现承诺：

1. 在服务端建立与业务会话、目标任务／团队授权绑定的参与资格，定义连接、房间与退出规则；不能信任客户端自报的 uid、角色、源端或 task_id。
2. 从装配层引入网络传输适配器；WebSocket 等技术需另行确定。现有 `LocalChannelPort` 能提供适配线索，但不能仅把 `postMessage` 换成网络发送就认为跨设备同步完成。
3. 保留光标的帧定位、坐标投影、节流和生命周期保护，另行确定连接代次、seq 作用域、去重、超时、重连快照及在线颜色分配。
4. 将共享材料读取接到有鉴权的后端文件／材料接口，处理源页面关闭后的任务和在线资格；不能依赖源标签页一直在线或 IndexedDB 能被另一设备读取。
5. 注销、团队切换、权限失效、视口卸载时要取消订阅与待发送工作，防止旧连接写入新任务。当前团队偏好变化本身不代表原任务授权已改变，仍须按服务端规则处理。

### 6.3 标注、测量与分割如何接入服务器

现有保存链路为：原生测量／分割事件 → `TaskAutoSave` → 原生成果适配器 → 上传成果文件并提交整份清单 → 读取／恢复。应先理解它，再设计实时协作，不能将“自动保存”改名为“实时同步”。

| 入口 | 可以复用或需要调整的职责 |
| --- | --- |
| [ProjectRuntimeService.ts](platform/app/src/business/ProjectRuntimeService.ts) | 工作台生命周期、恢复完成后订阅、模式切换与自动保存装配 |
| [TaskAutoSave.ts](platform/app/src/business/TaskAutoSave.ts) | 测量／分割服务事件订阅、采集、上传、提交和恢复时的保护 |
| [ProjectUpdateBridge.ts](platform/app/src/business/ProjectUpdateBridge.ts) | 项目更新时间事件桥；更新时间不表示已经保存内容或广播修改 |
| [ProjectWorkspaceAdapter.ts](extensions/cornerstone/src/utils/ProjectWorkspaceAdapter.ts)、[TaskResultCodec.ts](extensions/cornerstone/src/utils/TaskResultCodec.ts) | 原生状态采集／恢复、对象与空间信息、自定义成果包编解码；不是通用多人增量协议 |
| [TaskStorageService.ts](platform/app/src/business/TaskStorageService.ts) 与 [后端 TaskStorageService](backend/phase-one/src/main/java/cn/colla/phaseone/storage/TaskStorageService.java) | 当前材料、成果上传／读取、base revision 与幂等提交；可作为初始化／重连快照的参考 |

接手时需要另行确定：

- 测量／定性标记与分割的对象身份、操作种类、坐标／参考序列、作者和删除语义，不能假定全部都是二维点列表。
- 实时操作与当前整份快照保存之间的关系；服务器如何排序、校验、去重和持久化，以及出现冲突时由谁合并或拒绝。
- 远端操作应用到 OHIF 后如何防止再次触发本地发送／自动保存；本地未确认修改、撤销重做及重连补偿如何处理。
- 增量消息缺失、乱序和重连时，如何获取一致快照并继续；现有 `operation_id/revision` 不能直接当成完整实时协议。

目前没有这些服务器实时端点／消息格式；不要在接口列表中写入虚构的 WebSocket 路径或声明已经支持多人标注同步。

### 6.4 后续验证应覆盖的边界

接手者实现服务器同步后，应覆盖独立浏览器配置或不同设备、不同账号与权限、同帧／异帧光标、相同对象并发编辑、分割大数据、断线重连、乱序／重复消息、注销与卸载后的清理，以及成果保存与重连恢复的一致性。这是后续验收参考，不代表本次已经执行这些验证。

### 6.5 本次协作功能验证

命令执行意图：运行真实后端全部集成测试并检查行／分支覆盖率门禁。预期输出：`BUILD SUCCESS`；行覆盖率与分支覆盖率均不低于 80%。

```sh
mvn -B -f backend/phase-one/pom.xml verify
```

命令执行意图：使用专用前后端运行一期真实浏览器回归，包含两个独立账号的 `edit/view` 协作流程。预期输出：全部测试通过；不会复用或停止用户正在运行的服务。运行前确认专用端口 3336、18081 空闲，且 JDK 21／Maven 已加入 PATH。

```sh
yarn playwright test --config playwright.phase-one.config.ts
```

验证仍区分业务单测、真实后端、浏览器流程、构建和类型检查。全库 TypeScript 在本次修改前存在 416 条诊断；不能把存量诊断或“总数相同”描述为类型检查通过。改动应按文件与诊断内容对比，不增加新的诊断。

## 7. 上游项目与许可证

- 上游：[OHIF Viewers](https://github.com/OHIF/Viewers)，由 Open Health Imaging Foundation 及其社区维护。
- 官方文档：[docs.ohif.org](https://docs.ohif.org/)；上游在线演示：[viewer.ohif.org](https://viewer.ohif.org/)。上游功能介绍不代表本 fork 的业务后端全部实现。
- 本仓库保留 [MIT 许可证](LICENSE) 与原有版权声明；第三方依赖遵守各自许可证。

MIT © [OHIF](https://github.com/OHIF)
