# Desktop Agent

Desktop Agent 是一个本地优先的桌面 Agent 工作台，技术栈为 Electron、Vite、TypeScript、React、Ant Design X，并通过 GitHub Copilot SDK 和 CodeBuddy Agent SDK 执行任务。

## 体验与能力

- 以 Ant Design X 的消息气泡与输入组件为基础，采用 Tbox 风格的对话工作台：会话导航、快捷任务建议、运行状态和主输入区。
- Copilot 与 CodeBuddy 通过独立适配器接入；会话、运行事件、停止执行与错误处理由宿主统一管理。
- 对话历史和偏好设置写入 Electron 用户数据目录，应用重启后仍可恢复。
- Agent 执行期间支持流式输出和停止；非只读工具操作需要主进程发起的单次用户确认。
- 默认优先使用 GitHub Copilot；只有检测到配额、请求频率或资源耗尽类错误时，才自动切换到 CodeBuddy。已批准可能产生副作用的操作后不会自动重放任务。
- 工作目录默认为 Documents 下的 Desktop Agent Workspace，可在偏好设置中切换。

## 开发环境

需要 Node.js 22.13 或更高版本。安装依赖后运行 `npm run dev`。验证命令为 `npm run typecheck`、`npm test` 和 `npm run build`。

## Agent 认证

应用复用本机 Agent 运行时的登录状态，不在 Renderer 中保存访问令牌。GitHub Copilot 和 CodeBuddy 需要分别在本机完成认证。

## 架构边界

- `src/main`：Electron 主进程、会话与设置持久化、运行时编排和 SDK 适配器。
- `src/preload`：隔离后的最小 IPC API，不向页面暴露 Node.js 或原始 IPC。
- `src/renderer`：React 对话工作台。
- `src/shared`：共享类型和 IPC 合同。
- `src/main/agent/workspace.ts`：共享工作区读取校验。
- `src/main/agent/policy.ts`：Provider fallback 和错误分类，不承担授权策略职责。

## 安全边界与当前限制

当前版本是个人本地使用的原型，不应视为企业级安全运行环境。SDK 权限回调和用户确认表达单次操作意图，不构成 OS 级沙箱，也不会自动降低本机进程的文件、网络或凭证权限。

工作区读取会解析文件系统真实路径，拒绝普通符号链接越界和明显的 Glob 路径穿越；这仍不能消除检查与使用之间的 TOCTOU 竞态。所有非只读工具仍由 SDK 运行时执行，用户批准后可能获得本机用户权限。

企业部署前仍需实现 OS 级进程隔离、文件句柄级边界、网络出口控制、凭证隔离、数据治理和可审计的撤销机制。当前不建设独立 PAP/PIP 服务或策略 DSL，避免为单用户桌面应用引入没有实际使用场景的策略平台。

架构决策见 [ADR 目录](docs/adr/README.md)。
