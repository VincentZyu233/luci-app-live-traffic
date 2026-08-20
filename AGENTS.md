# AGENTS.md

## 适用范围

- 本文件适用于整个 `luci-app-live-traffic` 仓库喵。
- LALT 是 OpenWrt LuCI 实时下挂设备流量监控插件，当前测试目标为 OpenWrt 23.05.4 `ramips/mt7621` 喵。
- 优先保持 LuCI 原生模块风格、现有目录边界和轻量运行时依赖喵。

## 行为边界

- 流量历史只保存在浏览器内存，不得新增持续写入路由器闪存的高频历史记录喵。
- Flow Offloading 只检测和提示，不得由插件自动修改防火墙卸载配置喵。
- 不得提交真实路由器地址、账号、密码、SSH 密钥、浏览器私有路径、MAC、设备名或真实设备截图喵。
- 私有配置只能放入已忽略的 `scripts/test/.env`、`tmp/` 或其他明确忽略的私有文件喵。
- 不得覆盖或撤销用户已有的无关工作区改动喵。

## 验证要求

基线检查应与 `.github/workflows/ci.yml` 保持一致喵：

```bash
node --test tests/core.test.mjs
find htdocs -name '*.js' -print0 | xargs -0 -n1 node --check
find root -name '*.json' -print0 | xargs -0 -n1 jq empty
find scripts -name '*.py' -print0 | xargs -0 python -m py_compile
```

- 当前 Python 验证是 `py_compile`，仓库尚未接入 pytest，不得声称或假设 `uv run pytest` 可用喵。
- 修改 UI、图表、主题或响应式布局时，应按需运行真实 LuCI Playwright 验收喵。
- 浏览器测试依赖使用 `uv venv tests/.venv` 和 `uv pip install --python tests/.venv -r scripts/test/requirements.txt` 安装喵。
- 先运行目标页面、质量和视口的小矩阵，再按风险决定是否运行默认 30 案例完整矩阵喵。
- 浏览器截图和报告只能输出到已忽略的 `tmp/browser-debug/`，提交前必须确认没有被 Git 追踪喵。

## 提交格式

- 仅在用户要求提交时执行 `git commit`，仅在用户要求推送时执行 `git push` 喵。
- 提交标题使用 `<English type>(<English scope>): <中文描述>` 格式喵。
- 提交应附加 `Co-authored-by: Codex <codex@openai.com>` 尾注喵。
- 提交前运行与改动风险相称的测试，并执行 `git diff --check` 和隐私检查喵。

## CI 选择

- 每次准备执行 `git commit` 前，若用户尚未明确选择，必须主动询问以下三个互斥选项喵。
- `普通提交（推荐）`：不添加构建关键词，只运行快速检查喵。
- `[build-action]`：运行快速检查并使用 OpenWrt SDK 构建、上传 IPK Artifact，但不创建 Release 喵。
- `[build-release]`：运行快速检查、构建 IPK，并创建 GitHub Release 喵。
- 默认始终为普通提交，不得因为代码、CSS、版本号或打包文件发生变化而自行添加构建关键词喵。
- 用户已经在当前请求中明确选择时，不得重复询问喵。
- `[build-release]` 优先级高于 `[build-action]`，不得在同一提交中同时添加两个关键词喵。
- 选择 `[build-release]` 时，提交前必须更新 `Makefile` 中的 `PKG_VERSION` 或 `PKG_RELEASE`，并确认目标标签或 Release 不存在喵。
- 普通 `main` 推送仍会启动 GitHub Actions 快速检查，但不会下载 SDK、构建 IPK 或发布 Release 喵。

快速检查包括以下内容喵：

- 解析提交信息中的构建关键词，并读取 `Makefile` 包版本喵。
- 检查全部 LuCI JavaScript 语法和 `root` 下 JSON 文件喵。
- 运行 Node.js 核心逻辑测试喵。
- 编译检查全部 `scripts/**/*.py` 文件喵。

## 部署与发布

- 真实路由器开发部署优先使用 `python scripts/deploy.py deploy --host <host>`，不得把私有连接参数写入仓库喵。
- 部署前后应验证 RPC 状态和目标资源文件，UI 改动还应检查浏览器控制台、布局和 Canvas 非空状态喵。
- `[build-action]` 产物只用于 Actions Artifact；只有用户明确选择 `[build-release]` 时才允许创建公开版本喵。
