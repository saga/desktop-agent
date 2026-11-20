# Desktop Agent

Desktop Agent 是一个本地优先的桌面 Agent 工作台，使用 Electron、Vite、TypeScript、React、Ant Design X，并通过 GitHub Copilot SDK 和 CodeBuddy Agent SDK 执行任务。

## 能力

- Copilot 与 CodeBuddy 通过独立适配器接入；会话、运行事件、停止执行和错误处理由 Electron 主进程管理。
- 对话历史和偏好设置保存在 Electron 用户数据目录。
- Agent 执行期间支持流式输出和停止；需要授权的工具操作由主进程请求用户确认。
- 默认优先使用 Copilot；仅在额度或请求频率错误时尝试切换到 CodeBuddy。已批准可能产生副作用的操作后不会自动重放任务。
- 工作目录默认为 Documents 下的 Desktop Agent Workspace，可在设置中更改。

## 开发

需要 Node.js 24 或更高版本；Windows 使用 MXC 原生 stdio 时要求 24.21.0 或更高版本。安装依赖后运行 `npm run dev`。验证命令为 `npm run typecheck`、`npm test` 和 `npm run build`。应用运行时会从 PATH 和常见安装位置查找系统 Node.js 24，用于启动 MXC Helper；不会使用 Electron 内置 Node Runtime 执行 MXC。

## Agent 认证

应用复用本机 Agent 运行时的登录状态，不在 Renderer 中保存访问令牌。GitHub Copilot 和 CodeBuddy 需要分别在本机完成认证。

## 架构

- `src/main`：Electron 主进程、会话存储、运行时编排和 SDK 适配器。
- `src/preload`：隔离后的最小 IPC API。
- `src/renderer`：React 对话工作台。
- `src/shared`：共享类型和 IPC 合同。
- `src/main/agent/workspace.ts`：真实路径校验。
- `src/main/agent/policy.ts`：跨 Provider 共享的隐式读取规则，以及 Provider fallback 和错误分类。
- `src/main/agent/sandbox.ts`：查找兼容的系统 Node.js 24，并启动独立 MXC MCP Helper。
- `src/main/sandbox/mcp-server.mjs`：MXC 命令执行 MCP Server，统一限制文件系统、网络和执行时长。

两个 Provider 共用同一条隐式读取规则：只有明确的单文件 `Read`，且真实路径位于工作区内，才免于逐次审批。目录遍历、Glob、Grep、Skill、Task 工具、Shell、网络、写入和未知工具均进入主进程审批流程。未知操作不会被默认为安全。

## 安全边界与限制

当前版本仍是个人本地使用的原型，不应视为企业级安全运行环境。

- Electron Renderer 使用隔离配置，IPC 限制到可信应用主 Frame。
- 工作区读取使用 `realpath` 检查，可阻止普通 Symlink 越界；仍不能完全消除检查与打开之间的 TOCTOU 竞态。
- Copilot 和 CodeBuddy 的原生 Shell 工具均被拒绝；命令只能通过 MXC MCP 工具执行。
- macOS 使用 MXC Seatbelt；Windows 使用 MXC ProcessContainer，并在启动时执行无副作用的能力探测。Windows 只接受 `base-container`，不运行 `wxc-host-prep.exe`、不请求 UAC；需要管理员预处理或隔离能力不足时拒绝执行。
- MXC 命令执行默认只允许工作区和临时目录写入，系统工具链只读，网络入口和出口默认拒绝。宿主机凭证目录不在命令执行的文件系统授权路径内；用户自定义 PATH 中位于这些凭证目录下的路径不会被加入只读白名单。
- 这层隔离目前只覆盖 Shell/命令执行；Provider 自身的文件工具仍由主进程授权和路径策略控制。
- 额度 fallback 在已批准可能产生副作用的操作后停止自动重放。
- 当前没有统一网络出口控制、凭证代理、DLP、企业策略管理、持久化安全审计或 Kill Switch。

架构决策见 [ADR 目录](docs/adr/README.md)。后续仍需验证不同 Windows/macOS 版本上的实际隔离效果、SDK 原生资产打包、文件访问竞态，以及 MCP 取消通知到 OS 进程终止的完整链路。不要用更多审批 UI 或抽象策略层替代实际执行边界。
