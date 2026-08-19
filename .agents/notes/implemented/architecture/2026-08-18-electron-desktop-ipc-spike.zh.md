# Agent Note: Electron 桌面 IPC 进程边界

[English](2026-08-18-electron-desktop-ipc-spike.md) | 中文

Status: implemented

## Problem

桌面程序需要把 Electron 窗口与基于 Node 的 Harness 运行时隔离，同时保持客户端协议与物理载体无关。Renderer 不能获得 Node.js 或任意 IPC 访问，Host 失败也不能终止窗口进程。

## Decision

`apps/desktop` 包含 Electron Main、沙箱 Preload、本地 Renderer 入口和受监管的 Host 子进程。Main 从本地文件加载 Renderer，使用带版本号的换行分隔 JSON 协议启动 Host，只把事件帧转发给 Renderer，并负责有界的 Host 关闭。Preload 只暴露 `invoke`、`cancel`、`subscribe` 和 `getState`，不暴露 `ipcRenderer` 或文件系统。

`HostSupervisor` 负责 pending 请求结算、ready 握手、事件转发、取消、异常退出失败、消息大小限制和有界停止超时。Host 消息在进程边界解析，未知版本、判别字段、stream、id 和 sequence 都会被拒绝。

当前 Host 入口是包含 `desktop.spike.echo` 与 `desktop.spike.wait` 的生命周期夹具，明确不是 Harness 运行时。正式接入必须在同一进程边界后替换为 Desktop profile 和现有 API Proxy 约定；Electron 壳和 Renderer 不得继续增加业务专用 RPC 方法。

## Alternatives considered

**把 Harness 运行在 Electron Main 中。** Agent、PTY 和原生模块故障会与窗口进程耦合，也无法独立重启 Host。

**向 Renderer 开放 Node integration。** UI 代码会获得不受限的文件和进程权限，违反桌面安全边界。

**使用固定本地 HTTP 服务作为桌面载体。** 仓库的 GUI 分层要求物理载体可替换，并为 Electron 预留本地文件入口加 IPC；固定端口还会暴露不必要的本机网络面。

## Consequences

桌面包现在拥有可独立测试的进程边界和真实的 Electron-as-node 冒烟路径。Renderer 仍只是协议探针，Host 夹具也没有 Harness 能力；下一阶段需要增加 Desktop profile、API bridge、client carrier、正式图标和安装器。
