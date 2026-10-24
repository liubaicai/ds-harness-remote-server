# DS Harness Remote — 自托管 Server（独立版）

[English](README.md) · **中文**

本仓库是 [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) 的 **Server 端**，从上游 `apps/server` 抽离成可独立构建、部署和改造的完整项目。

它服务于**该项目的 Host 插件与客户端**（桌面端、Web、Android、dsh-TUI），Server 侧不需要其他任何组件：本仓库已包含 HTTP/WebSocket 服务、账号与设备注册表、Web 管理界面，以及客户端所讲的那套协议 schema。

> 基线：上游 `apps/server`，提交 [`4d888ad`](https://github.com/liguobao/ds-harness-remote/tree/4d888ad3e359416836072796d06348eba37eccc6)（版本 `0.5.19`），外加下文[与上游的差异](#与上游的差异)。

## 为什么有这个 fork

上游的自托管 Server 是**设计上只走 Relay**：`hello.ack` 里写死 `webrtcEnabled: false`，能力列表只有 `transport.relay`，WebRTC 信令帧被直接丢弃，`GET /api/v1/turn/credentials` 端点根本不存在。客户端因此跳过 LAN/P2P/TURN，永远绕服务器中转。

本 fork 打通了整条降级链 —— **LAN → P2P → TURN → Relay**，只有该退化的时候才用 Relay。

## 快速开始（Docker）

```bash
git clone git@github.com:liubaicai/ds-harness-remote-server.git
cd ds-harness-remote-server
cp .env.example .env
# 编辑 .env：DSH_SERVER_ACCOUNT、DSH_SERVER_PASSWORD（12 位以上）、DSH_SERVER_PUBLIC_URL
docker compose up -d --build
```

打开 <http://localhost:8080>。设备凭据保存在 `server-data` 卷中，`docker compose down` 停止服务。

公网访问请在前面放 HTTPS 反向代理，不要把 Node 监听端口直接暴露到公网。代理需支持 `/ws/v1/connect` 的 WebSocket Upgrade，空闲超时大于 75 秒。

### 反向代理安全配置

Server 默认忽略 `X-Forwarded-For`，以 socket 对端地址作为登录限流和审计地址。可用 `DSH_SERVER_TRUSTED_PROXIES` 配置逗号分隔的**受控反向代理精确 IP 或 CIDR**，例如同机代理使用 `127.0.0.1,::1`。Docker 内观察到的可能是网桥网关，请配置实际对端地址，不要假定它是回环地址。非法配置会使服务启动失败。不要信任公网/客户端网段，也不要配置全信任网段（`0.0.0.0/0`、`::/0`）。

仅当直连 socket 对端可信时才读取 XFF，并从**右向左**剥离可信代理，遇到第一个不可信地址即停止。IPv4-mapped IPv6 会归一化成 IPv4；非法链回退到 socket 对端。可信代理必须用实际对端覆盖 XFF（单层 nginx 边缘代理可用 `proxy_set_header X-Forwarded-For $remote_addr;`），或向正确管理的链追加真实连接方地址，绝不能原样盲转客户端伪造的头。还应通过绑定地址/防火墙限制后端直连，可信列表不能替代访问控制。不配置可信列表时，同一反代下的所有用户会共用登录限流桶。

### 删除已配对设备

账号鉴权接口 `DELETE /api/v1/account/devices/:id` 成功返回 `200 {"status":"deleted"}`，支持账号会话 cookie 或账号 bearer token，不接受设备 token 作为账号权限。删除会移除设备和对应 token、断开其活跃 WebSocket，并释放 256 台设备上限中的名额。已吊销的设备也可以删除（设备列表仍只展示活跃设备）。服务会保留最小的已删除 ID 标记，防止旧设备凭据冒名重新注册；重新配对需要创建新设备 ID，再完成配对。删除设备记录不会删除 Host 上的远端文件或数据。

### 使用预构建镜像

CI 会在测试通过后自动构建多架构镜像（amd64/arm64）并发布到 `ghcr.io/liubaicai/ds-harness-remote-server`：

```bash
docker run -d --name dsh-remote-server \
  -e DSH_SERVER_ACCOUNT=you@example.com \
  -e DSH_SERVER_PASSWORD=<12位以上密码> \
  -e DSH_SERVER_PUBLIC_URL=https://remote.example.com \
  -p 8080:8080 -v dsh-server-data:/data \
  ghcr.io/liubaicai/ds-harness-remote-server:latest
```

标签规则：`latest` 和 `main` 跟随主干，`v*` 发布标签生成 `0.5.19`、`0.5` 这类语义化版本，另有 `sha-<短哈希>` 对应每次提交。在 Compose 中使用时，把 `server` 服务的 `build:` 块替换为 `image: ghcr.io/liubaicai/ds-harness-remote-server:<标签>`，其余配置不变。

## 本地运行

需要 Node.js 22 与 pnpm 9.15.4。所有命令都在仓库根目录执行 —— 这里不再是 workspace，也没有 `apps/`、`packages/` 的层级：

```bash
pnpm install
pnpm build                 # tsc → dist/，vite → dist/public/
cp .env.example .env       # 然后填写账号与密码
node --env-file=.env dist/main.js
```

开发时可热重载：`pnpm dev`（tsx watch `src/main.ts`；Web UI 需先 `pnpm build` 生成到 `dist/public/` 才会被托管）。

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 直接从 TypeScript 源码运行 |
| `pnpm build` | 编译 `src/` 到 `dist/`，并构建 Web UI 到 `dist/public/` |
| `pnpm start` | 运行编译产物（`node dist/main.js`） |
| `pnpm check` | 对 Server 与 Web UI 做类型检查 |
| `pnpm test` | 运行测试 |

Host 与客户端填同一个 Server 地址，用同一账号登录。账号建议用邮箱，以兼容现有客户端。

## 配置项

| 环境变量 | 用途 / 默认值 |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | 必填，登录账号 |
| `DSH_SERVER_PASSWORD` | 必填，至少 12 字符 |
| `DSH_SERVER_PUBLIC_URL` | 浏览器访问地址，默认 `http://localhost:8080` |
| `DSH_SERVER_HOST` | 监听/端口映射地址，默认 `127.0.0.1`；局域网设为 `0.0.0.0` |
| `DSH_SERVER_PORT` | 默认 `8080` |
| `DSH_SERVER_DATA_FILE` | 默认 `data/state.json`，相对启动目录 |
| `DSH_SERVER_TRUSTED_PROXIES` | 逗号分隔的可信代理精确 IP/CIDR；默认空（忽略 XFF），仅信任受控代理 |
| `DSH_SERVER_WEBRTC` | 是否代理 LAN/P2P/TURN 协商，默认 `1`；设为 `0` 则只走 Relay |
| `DSH_SERVER_STUN_URLS` | 逗号分隔的 STUN 地址，默认 `stun:stun.miwifi.com:3478,stun:stun.cloudflare.com:3478`；设为空则关闭 STUN |
| `DSH_SERVER_STUN_PROBE` | 启动时探测 STUN 可达性并把最快的排到最前，默认 `1`；设为 `0` 关闭 |
| `DSH_SERVER_TURN_URLS` | 逗号分隔的 TURN 地址，默认空（仅有 STUN） |
| `DSH_SERVER_TURN_SECRET` | coturn 共享密钥，用于签发临时凭据 |
| `DSH_SERVER_TURN_USERNAME` / `DSH_SERVER_TURN_PASSWORD` | 静态 TURN 凭据，替代共享密钥 |
| `DSH_SERVER_TURN_TTL` | TURN 凭据有效期（秒），默认 `3600` |

## WebRTC 数据面（LAN → P2P → TURN → Relay）

两端按四档依次降级，成功即停：

| 模式 | 数据路径 | 成立条件 |
| --- | --- | --- |
| LAN | 客户端 ↔ Host 直接通信，不出局域网 | 双方在同一二层网段 |
| P2P | 经 STUN 发现公网地址后 NAT 打洞直连 | STUN 可达、NAT 类型配合 |
| TURN | 经 TURN 服务器转发，仍走 WebRTC | 有可用的 TURN 地址与凭据 |
| Relay | 客户端 ↔ 本服务 WebSocket ↔ Host | 无需条件，始终可用 |

Server 只做协商代理，不强制 Relay。它只负责：

1. 在 `hello.ack` 中声明 `transport.lan/p2p/turn/relay` 与 `webrtcEnabled: true`（取对端声明与本服务支持集的交集）；
2. 在连接双方之间原样转发 `signal.offer`、`signal.answer`、`signal.ice`；
3. 在 `GET /api/v1/turn/credentials?connection_id=<id>` 签发 ICE 凭据，且仅限该连接的双方。

加密边界没有变化：Noise IK 仍跑在 `/ws/v1/connect` 上，只有密文进入数据通道。Server 虽然能看到明文 SDP/ICE，但相比 Relay 并没有多拿到任何业务数据。

### STUN 与 P2P

STUN 默认使用 `stun:stun.miwifi.com:3478,stun:stun.cloudflare.com:3478` —— 国内低延迟的在前，全球 anycast 的兜底。没有 STUN 时，只有同网段或共用同一公网 IP 的两端能直连，其余全部回落到 Relay。设 `DSH_SERVER_STUN_URLS=` 为空可关闭，也可指向自建 STUN。

启动时服务会探测这些地址，把本机实际可达且最快的一个排到最前（`DSH_SERVER_STUN_PROBE=0` 可关闭）。浏览器对每个地址都会并行尝试，但 Host 侧的兜底 RTC 后端（原生 `@roamhq/wrtc` 加载失败时使用的 werift）只取第一条，所以这个顺序决定了它能否打洞成功。探测失败时保持你配置的原顺序。

### TURN

只有在打洞失败时才需要 TURN —— 对称 NAT、运营商级 NAT、严格的企业防火墙。用共享密钥部署 coturn：

```conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<与 DSH_SERVER_TURN_SECRET 相同的值>
realm=ds-harness-remote
min-port=49160
max-port=49200
no-multicast-peers
```

然后配置 Server：

```bash
DSH_SERVER_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
DSH_SERVER_TURN_SECRET=<共享密钥>
```

放通 `3478/tcp`、`3478/udp`、`5349/tcp` 以及中继端口段 `49160-49200/udp`。云主机处于 1:1 NAT 时，还需给 coturn 指定 `external-ip=<公网IP>/<私网IP>`。

凭据遵循 coturn REST 约定：`username=<过期时间戳>:<标签>`、`credential=base64(HMAC-SHA1(secret, username))`，因此 `DSH_SERVER_TURN_TTL` 秒后自动失效，且只签发给该活跃连接的双方设备。也支持用 `DSH_SERVER_TURN_USERNAME`/`DSH_SERVER_TURN_PASSWORD` 配置静态凭据，但那是长期有效的转发权限。

`docker compose --profile turn up -d` 可在 Linux 主机上拉起内置 coturn（中继端口段需要 host 网络）。请先配置高强度、非空的 `DSH_SERVER_TURN_SECRET`：若未配置或为空，coturn 容器会在开启中继前退出。普通 `docker compose up -d` 不需要 TURN 密钥，可选 profile 不再阻塞普通启动。静态用户名/密码会透传给 Server 供外部 TURN 服务使用，但不能替代内置 profile 的共享密钥要求。Compose 也会保留显式空值 `DSH_SERVER_STUN_URLS=`。Docker Desktop 环境请在宿主机上单独运行 coturn。

## 与上游的差异

| 位置 | 上游 | 本项目 |
| --- | --- | --- |
| `hello.ack` | `webrtcEnabled: false`，能力仅 `['transport.relay']` | 真实能力交集，`webrtcEnabled` 随配置下发，`webrtcFallbackTimeoutMs: 8000` |
| 建立连接 | 客户端必须声明 `relay` | 双方共同支持的任一传输即可，并记录到链路状态 |
| 信令 | `signal.*` 帧直接丢弃 | 在链路双方之间原样转发 |
| 选路 | 只接受 `transport === 'relay'` | 接受任一协商过的档位；Host 的路径通告只透传、不断链 |
| TURN | 没有 `/api/v1/turn/credentials`（404） | 设备鉴权 + 活跃连接归属校验 + 临时 coturn 凭据 |
| STUN | 单一硬编码地址 | 有序默认列表 + 启动期可达性探测 |
| 目录结构 | `apps/server` 位于 pnpm workspace 内 | 仓库根目录的单包结构 |

## 目录结构

```
src/                Server 源码（HTTP、WebSocket 网关、存储、ICE）
src/protocol/       自上游 packages/protocol 内置，即客户端所讲的线上协议
web/                Web UI（Vite + React + Ant Design），构建到 dist/public/
tests/              Vitest 测试，含内置的 Noise IK 实现
Dockerfile          多阶段生产镜像
compose.yaml        Server（以及可选的 coturn profile）
```

`src/protocol/` 与 `tests/support/crypto/` 是上游源码的副本，除 import 说明符外保持原样，便于直接覆盖文件重新同步。它们遵循上游 MIT 许可（见 `LICENSE`）。

## 测试

```bash
pnpm test        # vitest run
```

覆盖范围：账号/设备授权、凭据轮换/吊销/删除、可信代理与 XFF 防伪造（IPv4/IPv6）、Control 帧校验、真实 Noise IK 的端到端加密 Relay、中继授权与重放处理、WebRTC 协商代理（信令双向转发、未协商传输被拒、第三方注入被拒）、TURN 凭据签发、STUN 探测。Compose 回归测试会在安装 Docker Compose CLI 时渲染真实配置（不需要 Docker daemon），在有 POSIX shell 时执行缺少密钥的启动保护；工具不可用时跳过这些集成检查。

## 与上游同步

上游随时可能重构 `apps/server`。重新同步时：

1. 用上游 `apps/server/src/*` 覆盖 `src/`（保留本仓库的协议路径改写：`@dsh-remote/protocol` → `./protocol/index.js`）；
2. 用上游 `apps/server/web/` 覆盖 `web/`；
3. 重新套用上面列出的四处行为改动 —— 它们集中在 `src/gateway.ts`（握手、建连校验、信令、选路）、`src/server.ts`（TURN 端点与 STUN 探测接线）、`src/ice.ts` 与 `src/stun-probe.ts`。

## 许可

MIT，与上游一致。内置的 protocol/crypto 源码保留原始版权。
