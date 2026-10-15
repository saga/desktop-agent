# Desktop Agent

Desktop Agent 是一个本地优先的桌面 Agent 工作台，技术栈为 Electron、Vite、TypeScript、React、Ant Design X，并通过 GitHub Copilot SDK 和 CodeBuddy Agent SDK 执行任务。

## 体验与能力

- 以 Ant Design X 的消息气泡与输入组件为基础，采用 Tbox 风格的对话工作台：会话导航、快捷任务建议、运行状态和主输入区。
- Copilot 与 CodeBuddy 通过独立适配器接入；会话、运行事件、停止执行与错误处理由宿主统一管理。
- 对话历史和偏好设置写入 Electron 用户数据目录，应用重启后仍可恢复。
- Agent 执行期间支持流式输出和停止；文件修改、终端命令、网络访问等需要权限的动作会先显示操作详情，再由用户批准或拒绝。
- 默认优先使用 GitHub Copilot；只有检测到配额、请求频率或资源耗尽类错误时，才自动切换到 CodeBuddy。普通工具、认证和代码错误不会触发 fallback。
- 工作目录默认为 Documents 下的 Desktop Agent Workspace，可在偏好设置中切换到需要处理的项目目录。

## 开发环境

需要 Node.js 22.13 或更高版本。安装依赖后运行：

- npm install
- npm run dev
- npm run typecheck
- npm test
- npm run build

执行 npm run package 会先进行类型检查和策略测试，再构建应用并调用 electron-builder 生成当前操作系统的安装包。

## Agent 认证

应用复用本机 Agent 运行时的登录状态，不在 renderer 中保存访问令牌。

- GitHub Copilot：先安装并登录本机 GitHub Copilot CLI / SDK 所需运行环境。首次调用时如果认证不可用，应用会显示可读错误。
- CodeBuddy：先安装 CodeBuddy Code 并完成登录。若 Copilot 发生配额耗尽，且已开启额度 fallback，应用会自动尝试 CodeBuddy。

Copilot 模型默认设置为 claude-sonnet-5.5；CodeBuddy 默认设置为 glm-5.3-flash。两者均可在偏好设置中修改。若账号当前并不提供相应模型，请选择该账号实际可用的模型名称。

## 架构边界

- src/main：Electron 主进程、会话与设置持久化、运行时编排、Copilot/CodeBuddy 适配器。
- src/preload：隔离后的最小 IPC API，不向页面暴露 Node.js 或原始 IPC。
- src/renderer：React + Ant Design X 对话工作台。
- src/shared：主进程、preload 与 renderer 共享的类型和 IPC 合同。
- src/main/agent/policy.ts：运行时 fallback 策略和错误分类的纯函数及测试。

SDK 的工具权限在主进程侧处理，不能由 renderer 传入任意 Node.js 调用。会话数据存放在 Electron 的 userData/desktop-agent 目录中；该目录属于本地用户数据，删除应用数据前请自行备份重要对话。
