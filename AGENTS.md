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

## 开发与边界约定

- **语言约定**：代码注释与 JSDoc 统一使用简洁、规范、通用的英文（聚焦“为什么”：数学推导、数值稳定、零 GC 缓冲复用与浏览器行为约束）；回复与交付说明优先使用清晰一致的语言；提交信息和 PR 标题遵循 Conventional Commits（例如 `feat(core): ...`、`fix(dom): ...`），范围建议取 `core`、`dom`、`react`、`presets`、`playground`、`deps`。
- **零依赖边界**：严禁在 `@sessile/core` 中引入 React、特定前端框架或重型运行时库。
- **渐进增强契约**：`backdrop-filter: url(#svg)` 仅在 Chromium 完整支持；所有上层渲染与降级逻辑必须保持在 Safari / Firefox 下具备液态轮廓、磨砂底色与物理高光边，禁止以全屏截图替代实时 DOM。
- **性能与 GC 约束**：每帧热路径（SDF 求值、轮廓提取、Stored-PNG 生成）应尽量复用预分配 `TypedArray` 缓冲，避免 60/120fps 下频繁触发垃圾回收。
- **测试要求**：对核心数学、物理、PNG 编码格式、轮廓拓扑与 DOM 控制器状态机编写可重复的自动化测试，确保测试隔离并清理副作用。

## 常用命令

```sh
pnpm install --frozen-lockfile
pnpm dev          # 启动 Playground 开发服务器
pnpm typecheck    # 全工作区 TypeScript 检查
pnpm test         # 全工作区测试
pnpm lint         # oxlint 检查
pnpm build        # 全工作区构建
```

## 审查重点

- 是否破坏 `@sessile/core` 的零依赖或框架无关边界；
- 多图元 `smin`、Marching Squares 轮廓与 WebGL2 shader 的边界对齐精度与数值稳定性；
- 动画打断（mid-flight interruption）、`prefers-reduced-motion` 与无浏览器降级分支是否正常；
- 是否在热路径中引入不必要的每帧内存分配或布局抖动（layout thrashing）。
