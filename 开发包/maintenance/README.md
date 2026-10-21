# 开发包维护入口

- `check_project.py`：统一运行 Python 和 Node 回归，临时目录隔离测试存档与 Python 缓存。运行 `python3 开发包/maintenance/check_project.py`；可传 `--node PATH`。测试会绑定本机临时端口，Git 测试使用临时本地仓库，不上传正式项目。
- `installation_backup.py`：转发程序包内的 `主程序/manage_installation.py`，提供 `create / verify / restore / recover`。创建、恢复和中断回滚必须完整停服；同时锁住中央服务和所有已物化空间，备份中央账号、角色、全部房间、检查点及历史归档，拒绝在线或不完整归档。具体命令及崩溃恢复边界见 [多战役备份与崩溃恢复.md](多战役备份与崩溃恢复.md)。
- `audit_historical_saves.py`：只读扫描正式战役、整套备份、迁移前存档及旧恢复材料，按文件哈希去重比较；保存冲突文件单独计数，不当作已提交历史。SQLite 使用只读连接取得一致快照，再核对全部登记资源的哈希、尺寸和文档引用。运行 `python3 开发包/maintenance/audit_historical_saves.py --output 开发包/维护记录/核查目录`，不会载入、恢复或保存任何正式战役。
- `repair_portrait_bindings.py`：修复已有棋子的形态绑定。默认只生成检查结果，不写入；`--save-root PATH` 指定存档根目录。显式传 `--apply` 才执行并生成修复备份。正式运行前先保存并关闭主控台，查看默认模式报告后再决定是否应用。
- `verify_content_migration.py`：只读核查内容来源迁移前后是否保留全部旧字段。传入 `--before-db 迁移前备份.sqlite3 --after-db 迁移后.sqlite3 --plan 迁移预览.json`，可附 `--audit 只读审计.json --output 维护目录/报告.json`。核查全部数据库文档、物品快照及迁移回执，不执行迁移；应在后续 UI 操作前运行。报告通过返回 0，发现差异返回 1。生成独立 SQLite 备份时应在备份连接上设置 `PRAGMA journal_mode=DELETE` 再关闭，使快照不依赖 WAL 辅助文件；不要改变正式运行库的日志模式，也不要用 `immutable=1` 忽略活动 WAL。
- `migrate_content_origins.py`：正式内容来源迁移入口。默认仅生成只读方案：`--save-root 存档目录 --overrides 已确认来源.json --output 预览.json`。审查方案并关闭服务后，显式添加 `--apply --expected-plan-hash 已审查哈希`，将 `--output` 改为新的维护报告路径。执行前获取服务独占锁，验证哈希，创建整套备份，再核对哈希；迁移后自动进行保真检查。备份失败、服务运行或哈希变化均不会执行来源迁移。输出需放在程序包以外。重复同一方案返回既有回执，不自动再次迁移。
- `prune_stale_asset_locations.py`：整理 v4 工作区中已登记但不存在的原图位置索引。默认只读预览；`--apply --expected-plan-hash 已审查哈希 --output 新报告.json` 才离线应用。取得安装独占租约和全部已物化工作区服务锁，只在另一份已登记原图通过大小与 SHA256 校验时移除失效位置行；不删除原图、文档或 `asset_links`。应用前保存私有游戏模块数据库与原索引快照（目录 700、文件 600），经正式事务/outbox 刷新协调索引。输出必须在安装目录外。使用方法、12 项临时验收与投影失败重放边界见 本地失效资源位置维护入口与临时验收（不随源码发布）。

启动仍使用项目根目录入口。运行工具不需要移动正式存档、素材或制作产物。

内容来源迁移与失效资源整理须用 `--save-root` 指定具体房间的 `运行数据/存档`。中央账号目录会拒绝游戏维护；冻结历史归档仅允许只读预览，不能 `--apply` 修改。旧版形态修复工具只用于历史非 v4 工作区。

上述预览与核查的“只读”指不修改权威数据、模式或迁移记录，也不回放应用写入。使用 `server/sqlite_read.py` 的工具会把数据库及 WAL／journal 一致复制到私有临时目录，在该副本中恢复已提交记录并设置 `query_only=ON`；源数据库及其辅助文件不由 SQLite 打开或修改。不会改变正式库日志模式，也不使用 `immutable=1` 忽略活动 WAL。

- `archive_original_workspace.py`：离线归档原工作区，默认预览；`--root 程序包 --apply` 执行，`--verify PATH` 校验，`--rollback` 回滚中断事务。取得全安装独占锁，保留中央账号、角色、房间和会话代次。归档后旧入口回到账号页，归档拒绝作为服务启动。
