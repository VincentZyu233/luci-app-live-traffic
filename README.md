# luci-app-live-traffic

面向 OpenWrt 的轻量实时流量监控 LuCI 应用，按下挂设备展示上传、下载和最近 10 分钟走势。

## 功能

- WAN 实时上传、下载曲线。
- 按 MAC 聚合下挂客户端的实时速率与累计流量。
- 总览、设备矩阵和设置三个 LuCI 页面。
- 1、2、5、10 秒刷新间隔，默认 1 秒。
- 历史仅保存在浏览器内存，不持续写入闪存。
- 检测 Flow Offloading 并警告，不修改防火墙配置。

## 兼容性

- 已适配 OpenWrt 23.05.x 和 `opkg`。
- 首要测试目标为 OpenWrt 23.05.4 `ramips/mt7621`。
- 依赖 `nlbwmon` 与 `rpcd-mod-ucode`。

硬件或软件 Flow Offloading 会使部分流量绕过 conntrack，因此逐设备统计可能低于实际值。

## 开发部署

确保 SSH 公钥登录可用，然后执行：

```powershell
python scripts/deploy.py deploy --host 192.168.1.1 --identity $env:USERPROFILE\.ssh\id_ed25519
```

路由器需要通过 `proxychains4` 下载软件包时增加 `--proxychains`。命令仅调用路由器已有配置，不包含代理地址。

部署前预览命令：

```powershell
python scripts/deploy.py deploy --host 192.168.1.1 --dry-run
```

卸载开发版本并恢复插件管理的 `nlbwmon` 刷新间隔：

```powershell
python scripts/deploy.py uninstall --host 192.168.1.1
```

## 安装后

进入 **状态 -> 实时流量 -> 设置**，确认初始化后，插件会备份 `nlbwmon` 原刷新间隔并调整为选择的采样间隔。

流量数据范围仅包括经过本 OpenWrt 路由器转发的下挂客户端。它无法监控上游主路由的其他平级设备。

## 测试

```bash
node --test tests/core.test.mjs
node --check htdocs/luci-static/resources/live-traffic/core.js
```

## 许可证

[Apache-2.0](LICENSE)
