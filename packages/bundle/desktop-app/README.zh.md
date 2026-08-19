# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

桌面 Host 组合包。其 [`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上，挂载与传输无关的 Host API 及其支撑服务，选择原生目录选择器，并加入本包的 [`desktopRuntime`](src/index.ts) 胶水。该服务把组合后的 `apiProxy` fetch handler 与 mux/Host 事件流交给受监管的进程 bridge，同时不打开 HTTP 监听端口，也不提供浏览器资源。

桌面 renderer 持有构建生成的客户端 roster。Host 组合只挂载注册 `ui-onboarding` 设置命名空间所需的客户端包 Host 半侧；在 Host 中加载完整浏览器 roster 会让仅浏览器侧的注入一直等待，或重复提供共享服务。[`dsh-desktop` shell](../../../apps/desktop/README.md) 直接注入 preload transport，并通过本地 `app://` 协议提供构建后的 renderer。

## 模型体验

通过 base 编码 persona 与已挂载的运行时包间接产生影响，各个包分别持有自己的面向模型注册。

#### KV Cache 影响

桌面 bridge 胶水本身不增加内容；已挂载包保持各自的缓存行为。

## 已知限制与延期工作

- **桌面 IPC 仅限本地进程**：`desktopRuntime` 假定存在受监管且可信的 Host 进程，并刻意不提供网络监听器或远程认证。
- **renderer roster 是构建产物**：增加或移除客户端包后必须重新构建桌面应用，shell 才能提供更新后的 bundle。
