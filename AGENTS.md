# Agent Guidelines

本文件适用于在 **Sessile** 仓库中进行开发、修复、重构、测试、文档维护和代码审查的 AI Agent。各包处于 `0.x` 预发布阶段，API 可能在次版本间变动，具体包 API 和实现以当前代码与配置文件为事实来源。

## 项目定位

Sessile 是面向现代浏览器的 **Live-DOM 动态玻璃材料连续形变引擎**：支持任意 $N$ 个圆角矩形 / 胶囊玻璃图元在真实可交互 DOM 上进行连续 `smin` 融合、拉丝、分离与光学过渡。

- **包管理与环境**：Node.js 24+、pnpm 11.22.0（以根 `package.json` 为准）。
- **技术栈**：TypeScript 6（strict）、Vite、WebGL2 / 2D Canvas、SVG Filters、React 19（仅 `@sessile/react` 与 `@sessile/playground`）。

## Monorepo 结构

- `packages/core`（`@sessile/core`）：**零运行时外部依赖**的纯 TypeScript 内核，包含 $N$-图元 SDF 场、弹簧物理、光学解析、Stored-PNG 位移图编码器、Marching Squares 轮廓提取器、WebGL2/2D 边缘光渲染器。
- `packages/dom`（`@sessile/dom`）：框架无关的无头 DOM 控制器，负责三层节点编排、渐进增强能力检测、坐标同步与纯标准 CSS 光学属性读取（不得硬编码特定宿主应用的私有 CSS 变量）。
- `packages/react`（`@sessile/react`）：轻量 React 绑定层，不强依赖第三方动画库（如 `motion/react`）。
- `packages/presets`（`@sessile/presets`）：可选的交互预设（如 Popover/Menu 展开、Segmented 滑块、拖拽融合），不得将菜单/业务语义反向污染进 `core` 或 `dom`。
- `apps/playground`（`@sessile/playground`）：交互式在线展示与调参实验室。
- `tests/browser`（`@sessile/browser-tests`，私有不发布）：Playwright 真实浏览器渲染测试。与同一浏览器里的裸页面逐像素比较，不存基准截图；首次运行前执行 `pnpm --filter @sessile/browser-tests exec playwright install chromium firefox webkit`。

## 开发与边界约定

- **语言约定**：代码注释与 JSDoc 统一使用简洁、规范、通用的英文（聚焦“为什么”：数学推导、数值稳定、零 GC 缓冲复用与浏览器行为约束）；与维护者的沟通、交付说明、提交正文和 PR 正文使用简体中文。提交与 PR 的格式见下文“提交与 PR”。
- **入口边界**：各包主入口只放稳定 API；可选模块（`core/overlay`、`core/legibility`、`dom/legibility`）、实验性组件（`react/experimental`、`presets/experimental`）和只给兄弟包用的辅助（`core/internal`、`dom/internal`，无 semver 保证）走子路径。增删导出时同步更新各包 `test/exports.test.ts` 快照和 CHANGELOG。
- **零依赖边界**：严禁在 `@sessile/core` 中引入 React、特定前端框架或重型运行时库。
- **宿主隔离**：不得把任何宿主应用的私有 CSS 变量、调参面板、Context 或业务组件带进 Sessile；`@sessile/dom` 只通过标准 `getComputedStyle` 读取光学属性，`@sessile/react` 用原生 `matchMedia` 而不是动画库。
- **渐进增强契约**：`backdrop-filter: url(#svg)` 仅在 Chromium 完整支持；所有上层渲染与降级逻辑必须保持在 Safari / Firefox 下具备液态轮廓（SDF `clip-path`）、磨砂底色与物理高光边，禁止以全屏截图（如 html2canvas）替代实时 DOM。
- **性能与 GC 约束**：每帧热路径（SDF 求值、轮廓提取、Stored-PNG 生成）应尽量复用预分配 `TypedArray` 缓冲，避免 60/120fps 下频繁触发垃圾回收。
- **测试要求**：对核心数学、物理、PNG 编码格式、轮廓拓扑与 DOM 控制器状态机编写可重复的自动化测试，确保测试隔离并清理副作用。
- **修根因**：修复问题要找到根因，不加临时补丁、延时或特殊分支；修 bug 时补一条在旧实现上失败的回归测试。
- **浏览器测试**：`tests/browser` 与同一浏览器里的裸页面逐像素比较，不存基准截图；折射类用例只在 Chromium 跑，其余在三个引擎都跑。`retries` 固定为 0，不稳定的渲染测试要修好，而不是靠重试掩盖。

## 常用命令

```sh
pnpm install --frozen-lockfile
pnpm dev          # 启动 Playground 开发服务器
pnpm typecheck    # 全工作区 TypeScript 检查
pnpm test         # 全工作区测试
pnpm test:browser # 真实浏览器渲染测试（Playwright：Chromium / Firefox / WebKit）
pnpm lint         # oxlint 检查
pnpm build        # 全工作区构建
pnpm release:check # 按发布方式打包并检查 tarball（CI 每个 PR 都跑）
```

## 工作流程

- **开工前**：先读本文件，运行 `git status --short` 看清工作区，只改任务需要的文件。
- **本地文件**：`AGENTS.override.md`、`CLAUDE.md`、`PLAN.md`、`.claude/`、`.agents/`、`.codex/` 是各人的本地配置，已在 `.gitignore` 中，不得强制加入 Git，也不要在仓库文件里引用其中的内容。
- **每次改动后**：运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`；改动公开 API、导出或打包时再跑 `pnpm build` 和 `pnpm release:check`；改动渲染、光学或 DOM 控制器时跑 `pnpm test:browser`。
- **UI 与光学改动**：在 1280px 和 390px 宽度、浅色和深色下检查，对比 Chromium 折射与回退路径的边缘，并检查中途打断和 `prefers-reduced-motion`。
- **交付说明**：把已验证和未验证的内容分开列出，未验证的写明原因。

## 提交与 PR

- **提交信息**：Conventional Commits，`type(scope)` 用英文，描述用简体中文，例如 `fix(dom): 九宫格折射图在圆形与胶囊上不再出现接缝`；正文用中文说明为什么改、改了什么。一个提交只做一件事。破坏性变更在类型后加 `!`，正文写 `BREAKING CHANGE:` 和迁移方法，并同步 CHANGELOG。
- **可直接推送到 `main`**（检查通过、改动在单个包内且约 150 行以内）：bug 修复、性能修复、小功能、文案与样式、只改测试 / 文档 / 工具、依赖补丁版本升级。
- **必须开 PR**：跨包功能、大型重构、公开导出 API 变化、SDF / shader 数学、Stored-PNG 格式、Chromium 折射与回退管线、破坏性变更、依赖次版本及以上升级。拿不准时按风险判断。
- **PR 标题**：Conventional Commits 前缀加中文概述，例如 `test(browser): 在真实 Chromium、Firefox、WebKit 里测玻璃的渲染`。
- **PR 正文**（中文，三节）：
  - `## Summary`：先用一个 `diff` 代码块列出改了哪些文件、各改了什么，再用一两段话说明改动和原因。
  - `## Evidence`：验证结果（命令、测试数量、CI 运行、实测数据）；没验证的单独写 `**未验证：**`。
  - `## Merge Danger`：`**Door:**` 写 `two-way`（可轻易回退）或 `one-way`（发布、格式或 API 一旦放出难以收回）；`**Blast Radius:**` 写合并后影响到谁、影响什么。
- **只写仓库里的事**：PR 标题、正文和提交信息要让任何读仓库的人都看得懂：写改了什么、为什么改、怎么验证的，原因用代码和仓库里的事实说明。不要提仓库外的讨论、评审或审计文档及其条目编号、聊天记录、任务或某人的请求，也不要列下游项目的内部文件；影响面写成使用方升级时会遇到的变化。
- **合并**：PR 用 squash merge，合并提交标题与 PR 标题一致。
- **代码审查意见**（Codex 等）：逐条核实，按根因归并，修掉成立的，说明不采纳的理由；同一问题连续两轮相关意见时先重新评估设计。大型重构或仍有未解决的高风险时不要自动合并。

## 发版

详见 [RELEASING.md](RELEASING.md)。要点：

- 四个发布包共用一个版本号。准备发版的提交是 `chore(release): prepare vX.Y.Z`，只改版本号（`pnpm release:version X.Y.Z`）和 CHANGELOG。
- 合并到 `main` 后在合并提交上打 `vX.Y.Z` 标签并推送，由 CI 打包、检查并带 provenance 发布到 npm。不从本地机器发布。
- 推送发版标签、发布到 npm 需要维护者明确同意。
- `.gitattributes` 强制 LF；`release:check` 会拒绝含 CR 的 tarball。

## 审查重点

- 是否破坏 `@sessile/core` 的零依赖或框架无关边界；
- 多图元 `smin`、Marching Squares 轮廓与 WebGL2 shader 的边界对齐精度与数值稳定性；
- 动画打断（mid-flight interruption）、`prefers-reduced-motion` 与无浏览器降级分支是否正常；
- 是否在热路径中引入不必要的每帧内存分配或布局抖动（layout thrashing）。
