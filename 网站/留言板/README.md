# 酒馆传声后端

`worker.js` 是 Cloudflare Worker ES module，使用 D1 绑定 `BOARD_DB`。本次源码把留言、回复、点赞和作者删除绑定到已经验证的邮箱账号。公开读取不要求登录；公开内容只展示昵称、稳定 `authorId` 和查看者的 `owned`、`liked` 状态，不返回邮箱、原账号 ID、私有账号键或会话摘要。

本目录不是主站 Pages 静态发布内容。这里说明源码的部署合同；实际线上版本和生产验证记录应保存在部署者自己的私有维护目录，不以源码文件存在作为已经部署的依据。

## 首次部署与已有安装

`wrangler.toml` 是公开配置模板，没有指定 Cloudflare 账号，`database_id` 是明确的待填占位值，不能直接作为完整生产配置使用。首次部署需要自己的 Cloudflare 账号、D1 数据库与主域名路由：

1. 登录自己的 Cloudflare 账号，创建 D1 数据库，并保持 Worker 绑定名称为 `BOARD_DB`。
2. 将模板复制到源码目录外的私有位置，填入自己的 D1 数据库编号，核对 Worker 名称、`database_name` 与 `routes`。异地配置中的 `main` 应指向当前 `worker.js` 的绝对路径，避免使用旧 Worker 副本。
3. 新数据库执行 `schema.sql`；已有数据库按下文增量迁移说明处理。通过该私有配置发布 Worker，例如 `wrangler deploy --config /绝对路径/私有部署配置.toml`。
4. 在目标 Worker 的 Secret 中设置下文的身份签名密钥，核对账号服务、主站域名和 Worker 中的固定身份域一致。此项目的默认域名是 `sundollworld.com` 与 `pl.sundollworld.com`，自行部署到其他域名时需统一调整对应来源和身份校验。

已有本机部署的可用私有配置在 `程序包/运行数据/联机/留言板部署.toml`，已保留原 Cloudflare 账号、D1 数据库与路由，`main` 指向当前 `worker.js` 的绝对路径，文件权限为 `0600`。本机后续发布可从项目根目录运行 `wrangler deploy --config 程序包/运行数据/联机/留言板部署.toml`；本次只准备配置，没有执行部署。移动整个项目后须同步更正私有配置中的 `main` 路径。

原始配置与历史说明仍保存在 `开发包/维护记录/终盘审计-20261020/本机留言板部署/`。上述两处均为本机私有内容，不随源码发布。不要误建空数据库替换现有数据，也不要把实际配置复制回公开源码。身份 Secret 继续保存在受保护的配置位置，部署配置和原配置备份都不包含该 Secret。

## 身份接入与配置

主站从 `https://pl.sundollworld.com/api/account/site-session` 携带账号域 Cookie 获取短期身份票。Cookie 留在账号域，Worker 接收 `Authorization: Bearer <ticket>`，不会以 localStorage、昵称、`visitorId`、`deleteToken` 或前端账号字段作为身份。

在 Worker Secret 中配置 `BOARD_IDENTITY_SECRET`，与账号服务受保护文件 `主站留言身份密钥` 的字符串值一致。该值不得写入前端、发布包、日志或本文件。Python 身份桥使用 ASCII 十六进制字符串本身的字节签名，Worker 同样按 UTF-8 字节使用；不能把十六进制解码成另一个二进制密钥。身份派生键需要长期稳定；更换密钥前必须安排账号作者键的迁移，避免历史账号内容失去原身份关联。

票据为 HS256 JWT，固定 `iss=https://pl.sundollworld.com`、`aud=sundollworld-message-board`、`v=1`，包括 `sub`、`sid` 两个小写 64 位十六进制字符串、`publicId=board_` 加 32 位小写十六进制、账号昵称及整数 `iat/exp`。有效期最多 300 秒；`sub` 和 `publicId` 是身份桥对原账号 ID 按两个独立命名空间 HMAC 派生的值，`sid` 是当前会话 token 的私有摘要。任何这些私有值均不放在 URL 中。

GET 携带票时由 Worker 本地验签，取得 `owned` 和账号点赞状态；不携带票也能读取，`owned/liked` 为 false。POST 和 DELETE 必须先验签，再向固定 `https://pl.sundollworld.com/api/account/site-session/validate` 发送 `{ticket}`，检查当前会话仍有效。请求不跟随跳转，4 秒后取消；撤销或禁用返回 401，离线、超时、跳转、无效响应或配置缺失返回 503。失败前不触碰 D1 写入。GET 不需要远程复核，因此账号服务离线仍能匿名查看留言；有效期内的只读身份视图不表示旧票仍能写入。

`REVIEW_REQUIRED=false` 直接公开，`true` 保存待审核，默认 `true`；其他值返回 503。管理员可通过受控 D1 维护把具体内容状态改为 `published`，没有公开管理接口。CORS 默认允许 `https://sundollworld.com`、`https://sundollworld.pages.dev`；`ALLOWED_PREVIEW_ORIGINS` 仅额外允许显式配置的本机 HTTP origin。预检允许 `Content-Type, Authorization`，Worker 不启用浏览器 Cookie 凭据。

## 增量迁移

新数据库执行完整 `schema.sql`。已有数据库按顺序执行迁移 002、003、004，再执行 `migration-005-account-identity.sql`，核对三张新表及索引后再部署新 Worker。所有迁移均为可重复的 `CREATE ... IF NOT EXISTS`，005 不修改、删除或认领任何旧行。

新增 `board_authors` 保存内容 ID、类型、私有账号键和公开展示 ID；`board_message_likes`、`board_reply_likes` 分别以内容 ID 与私有账号键组成联合主键。旧 `message_owners`、`message_likes`、`reply_likes` 保留。旧匿名内容的 `authorId=null/owned=false`，不能通过相同昵称、旧访客 ID 或删除凭证绑定到新账号；旧匿名点赞计数保留，账号点赞单独去重。新 Worker 不再使用旧删除凭证授权。

迁移前应保留 D1 的可恢复状态并核对现有行数。这里没有执行生产迁移，也没有读取正式密钥或生产 D1。

## API

留言和回复提交分别使用 `POST /api/messages`、`POST /api/messages/:id/replies`，JSON 为 `{body,requestId}`，回复可选 `targetReplyId`。昵称来自已验证票据，前端提供的昵称和身份字段不参与授权。正文 trim 后为 1–500 个 Unicode 码点；不接受 NUL 或孤立代理字符，最大请求体 8192 字节。状态、ID 和 UTC 时间均由服务端决定。

每次逻辑提交生成一个 v4 UUID `requestId`，失败后重试复用。该编号在留言与回复间唯一，相同账号、正文、主留言和回复目标重试返回同一记录及 200；首次保存返回 201。改变账号、正文、类型、主留言或回复目标返回 409。账号改名或跨设备登录不会破坏原请求重放，保存时的昵称快照仍保留。兼容省略 `requestId`，但这种请求没有跨网络重试去重保证。内容、限流占位、账号作者及回复目标快照在同一 D1 `batch()` 事务内保存，写入失败全部回滚；只有本次实际插入的新行可写作者关系，防止并发重试认领已有或匿名记录。

主留言列表 `GET /api/messages` 为每页 20 条，按时间、ID 降序；回复 `GET /api/messages/:id/replies` 为每页 20 条，按时间、ID 升序。下一页仍使用不透明 `cursor`。只返回公开内容；账号作者字段不会改变游标语义。返回条目包含 `authorId`、`owned`、`likeCount`、`liked`，主留言另有 `replyCount`。`visitorId` 查询参数不再决定查看者的身份或点赞状态。

回复目标必须是同一公开主留言下的公开回复，保存事务再次检查目标和主留言。目标昵称由数据库复制，客户端 `targetNickname` 不采用。目标回复被删除后，后续回复仍保存原目标昵称，不连带删除；已有提交的重放可正常确认。新提交遇到目标在写入前消失返回 404，不留下账号作者或限流占位。

主留言和回复点赞使用 `POST /api/messages/:id/like`、`POST /api/messages/:parentId/replies/:id/like`，JSON 只需要 `{liked:true}` 或 `{liked:false}`。这是目标状态而非反转动作，同一账号跨设备并发设置仍最多一票；重复取消不误增、不重复扣减。写入与最终状态、总计数读取处于同一事务。公开计数为旧匿名票加账号票，账号不能以旧访客标识认领或取消匿名票。

作者删除使用 `DELETE /api/messages/:id` 或 `DELETE /api/messages/:parentId/replies/:id`，携带 Bearer 票及 JSON `{}`。账号必须匹配该内容的 `board_authors`，待审核内容也可由作者删除。主留言删除保留原行为：删除整条留言及全部回复、点赞、目标关系、作者关系、旧凭证及限流占位；回复删除仅删除该回复，后续回复目标昵称保留。所有删除语句在同一事务内重复约束目标与账号，事务失败返回 503并回滚；外人或匿名旧内容返回 403，错配父留言返回 404且不损坏作者关系。成功但响应丢失可重试，已不存在返回 `alreadyDeleted=true`。

独立 `rate_limits` 继续使用域盐 IP 摘要，留言与回复共用 30 秒来源发送间隔，七天后清理过期行。它只用于防刷，不是身份；Worker 不记录 IP 原文、票据、邮箱或留言正文到 console。

## 管理员维护

账号作者是多态关系，不能对两张内容表设统一外键。管理员如需删除主留言，应使用同一 D1 `batch()` 先清理对应留言、全部回复的限流占位、旧凭证与 `board_authors`，然后删除主留言及其自身凭证、作者关系。两个账号点赞表与旧点赞表、回复及回复目标由外键级联清理。不能只删除内容表，否则会留下作者关系或限流占位。该维护说明不构成生产删除授权。

D1 `batch()` 事务与失败回滚依据 [Cloudflare 官方文档](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。本地测试执行实际 Worker ES module 和 SQLite SQL，检查增量迁移重复执行、原匿名数据保留、票据伪造/过期/缺字段、真实会话撤销与离线拒绝写入的模拟、跨设备作者删除、并发重试和点赞、事务回滚、回复目标竞争、同时间分页和错误/CORS边界。另以真实 Python `site_identity.issue/validate` 和合成账号检查跨语言票据兼容，不读取正式密钥。

验收命令（Node.js 24 或支持 `node:sqlite` 的兼容版本）：`node --test 开发包/tests/test_guestbook_accounts.cjs`。完整记录见 `开发包/维护记录/账号体验整合-20261011/留言账号后端.md`。这些结果没有包含生产部署或真实公开写入验收。

历史部署版本、恢复书签和生产验收详情只保留在上述本机私有维护目录，不作为新安装的操作参数。
