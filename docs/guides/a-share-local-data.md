# A 股本地数据、选股面板与 zettaranc 联动（本 fork 新增）

本文说明这个 fork 在上游 dsh-trading 之上新增的 A 股功能、需要的本地软件、配置方法，以及**怎样接入你自己的通达信公式**。所有新增功能都是可选的：不配置时自动关闭，终端照常用原来的行情接口工作。

> 本 fork 沿用上游的 PolyForm Noncommercial 1.0.0 许可，仅限非商业使用。以下功能产出的一切内容（选股结果、多空区间、角色分析）都是规则的机械计算或模拟分析，**不构成投资建议**。

## 功能一览

| 功能 | 依赖 | 不满足依赖时 |
|---|---|---|
| A 股 / ETF 日线读本地通达信（前复权、成交量单位、ETF 价格 ×1000 与份额拆分） | 通达信客户端 + 已下载盘后数据 | 日线走原来的行情接口 |
| 日线图「活跃市值多空区间」背景（指南针 0AMV） | 指南针客户端 + 通达信（交易日历） | 背景显示「未配置」 |
| 股本 / 换手率（通达信除权文件 gbbq） | 通达信 | 换手率留空 |
| 右缘竖栏「选股」页签：用**通达信自己的公式引擎**跑你的选股公式 | 通达信金融终端（带 TQ 策略 Python 插件）开着 + zettaranc 技能 | 面板提示「通达信引擎不可用」 |
| 自选「今日选股」分组自动同步 | zettaranc 技能的每日报告写出 `report-picks.json` | 不同步，分组保持原样 |
| `Zettaranc（Z哥视角）` 分析角色 | zettaranc 技能 | 角色仍可用，但没有技能的规则与命令 |
| 图表工具条「Z哥诊断」浮窗：按技能规则算出选股结论、砖块、B1、卖出信号、黄白线、BOLL、活跃市值，可复制给 Z哥角色解读；港股只作参考 | zettaranc 技能（港股另需在通达信同步港股日线） | 浮窗写明「技能不可用」及原因 |
| 选股页签的结果按技能规则复核：留下 / 剔除 / 待复核（本地数据早于选股日时不参与剔除） | zettaranc 技能 | 照常列出通达信的原始结果 |
| 右缘「报告」页签：每日报告（点股票切图）与前向检验（入选后 5 / 10 日对比同日随机基准、上证、被剔除的票） | zettaranc 技能的每日报告 + `local-data.json` 的 `reportDir` | 提示「未配置」 |
| 顶部一行数据新鲜度：本地日线、活跃市值各到哪天 | 通达信 / 指南针 | 不显示 |
| 自选添加框搜索修复、A 股成交量单位修复 | 无 | — |

## 0. 安装（Windows）

1. **建 profile**：按上游 README「快速开始」建 `trading-web` profile。Windows 上 `dsh` 命令默认不在 PATH，它是 DeepSeek Harness 安装目录下的 `resources\runtime\cli\bin\dsh.cmd`，用完整路径调用即可。
2. **构建本分支**：在本仓库 `local-a-share` 分支运行 `pnpm install` 和 `pnpm build`（Node 版本见上游 README）。
3. **换成本分支的包**：停掉终端，把 profile 里 `node_modules/@dshtrading/<包名>/lib` 换成本仓库 `packages/<包名>/lib`。
   - 本 fork 改了 `base`、`bot-api`、`client-ui-trading`、`indicators`、`kit-cn`、`api` 的源码，`dsh-i18n` 会把各包的词典打进自己的产物，也跟着变。建议 profile 里的 `@dshtrading` 包全部替换，避免新旧版本混用。
   - 替换前先备份原来的 `lib`；先删除目标 `lib` 再复制：它可能是 pnpm store 的硬链接，原地覆盖会把 store 里的文件也改掉。
4. **启动**：设好 `DSH_HOME` 后运行 `dsh.cmd --profile trading-web --port 8888`，用浏览器打开它输出的地址（地址里的 token 是登录凭证，不要发给别人）。可以把这两步写进一个 `.cmd` 放在桌面，双击启动。终端是网页版，在浏览器里使用，不在 DeepSeek Harness 客户端窗口里。
5. **本地数据与技能**：本地数据目录见第 1 节；zettaranc 技能的安装见第 2 节。

## 1. 本地数据目录：`local-data.json`

在 DSH home 目录（`DSH_HOME`，默认见上游文档）下新建 `local-data.json`：

```json
{
  "tdxDir": "D:/new_tdx64",
  "zhinanzhenDataDir": "D:/Program Files/WavMain/ANALYSE/Data/ChinaStk",
  "reportDir": "D:/stock/reports"
}
```

- `tdxDir`：通达信安装目录，里面要有 `vipdoc/`（日线 `.day` 文件）和 `T0002/hq_cache/gbbq`（除权）。路径以你自己的安装位置为准。
- `zhinanzhenDataDir`：指南针的 `ANALYSE/Data/ChinaStk` 目录，里面的 `Z_SK/day.vdat` 存活跃市值 0AMV。没有指南针就不写这一项。
- `reportDir`：zettaranc 每日报告的目录（技能 `.env` 里的 `REPORT_OUT_DIR`，里面有 `data/YYYY-MM-DD.json`），「报告」页签读它。不用报告就不写。

改完不用重启，下一次请求就会读到。也可以用环境变量覆盖（优先级更高）：

| 环境变量 | 作用 |
|---|---|
| `DSH_TRADING_LOCAL_DATA_CONFIG` | 换一个 `local-data.json` 的位置 |
| `DSH_TRADING_TDX_DIR` | 通达信目录 |
| `DSH_TRADING_TDX_GBBQ_FILE` | 除权文件 |
| `DSH_TRADING_AMV_FILE` | 0AMV 文件 |
| `DSH_TRADING_AMV_CALENDAR_FILE` | 交易日历（默认取通达信上证指数日线） |
| `DSH_ZT_SKILL_DIR` | zettaranc 技能目录（默认 `DSH_HOME/skills/zettaranc-perspective`） |
| `DSH_REPORT_PICKS_FILE` | 每日选股名单文件（默认 `DSH_HOME/report-picks.json`） |
| `DSH_TRADING_REPORT_DIR` | 每日报告目录（同 `reportDir`） |

**数据新鲜度**：本地日线只到通达信最后一次下载盘后数据的那天，当天缺的一根由行情接口补；活跃市值要在指南针里打开过 0AMV 页面才会写进本地文件（只开关指南针不会更新）。

## 2. 选股页签（通达信公式引擎）

右缘竖栏最下面的漏斗图标。它列出你在通达信里保存的**自定义条件选股公式**，选一个点「选股」，由通达信自己的公式引擎算出结果，所以和通达信「一键选股」一致，不需要把公式移植过来。

准备：

1. 用带 TQ 策略插件的通达信金融终端（安装目录下有 `PYPlugins/sys/tqcenter.py`），并保持它运行。
2. 安装 zettaranc 技能（按技能仓库 README 的「本地 A 股数据与每日报告」一节），技能目录放在 `DSH_HOME/skills/zettaranc-perspective`，或用 `DSH_ZT_SKILL_DIR` 指过去。依赖必须装在技能目录下的 `.venv` 里：选股页签固定调用 `技能目录/.venv/Scripts/python.exe`，找不到时面板会提示 `zettaranc skill python not found`。技能的 `.env` 里要配置 `TDX_DIR`。

使用：

- 「沪深主板 / 全部 A 股」决定结果范围；
- 点股票名切换中间的 K 线；「存为分组」写进「通达信·公式名」分组；
- 盘中运行时用的是当天的实时 K 线（和一键选股一样），面板顶部会写明日期；
- 只调用 TQ 接口里的公式列表和批量选股，**不调用任何下单 / 撤单函数**。

## 3. 接入你自己的公式

**本仓库不包含任何第三方或付费课程的公式原文**。你的公式只放在你自己的电脑上：

### 3.1 选股公式（推荐）

1. 在通达信「公式管理器 → 条件选股公式」里新建，粘贴公式代码，保存（通达信会检查语法）；
2. 回到终端的选股页签点「刷新公式列表」，选它运行。

公式里用到 `DYNAINFO` 等实时函数时，结果只反映「现在」的行情：盘后跑当天没问题，回头补算历史日期会不准。

### 3.2 图表指标

在终端对话里把通达信指标公式贴给助手，让它用 `indicator_author` 工具做成自定义指标（compute 源码），再拿通达信里同一天的读数核对。自定义指标存在你的 DSH home 里，不会进仓库。图表对 `ZXB1 金砖` 类指标（id `zx_b1_bricks_core`）的砖块有专门的绘制支持，id 一致就能用上。

### 3.3 每日报告用的公式

zettaranc 技能的每日报告按公式名调用通达信引擎，报告里的「选股名 → 通达信公式名」在技能的 `.env` 里配置（见技能 README 的「本地 A 股数据与每日报告」）。

## 4. 「今日选股」分组同步

zettaranc 技能每天生成报告时把入选名单写到 `DSH_HOME/report-picks.json`：

```json
{ "date": "2026-11-03", "group": "今日选股", "picks": [{ "symbol": "002541.SZ", "name": "鸿路钢构" }] }
```

终端每分钟检查一次，把名单同步进同名分组：不再入选的移出分组；只有它自己新建的自选行才会被删掉（记在 `report-picks-state.json`），你手动加的自选永远不删。也可以用你自己的程序写这个文件。

## 5. Zettaranc 角色

角色名是「Zettaranc（Z哥视角）」：按公开整理的交易框架做 A 股择时、选股、买卖点和持仓诊断。**它是基于公开资料和粉丝笔记的模拟，不是本人**，不冒充本人、不编造他的观点和持仓，也没有下单工具。分析结论不构成投资建议。

## 6. 只在 Windows 上测试过

通达信、指南针的本地文件格式和 TQ 插件都只在 Windows 上验证过。文件格式按实测解析（见 `packages/bot-api/src/local-*.ts` 的注释），软件升级后格式可能变化，解析失败时一律关闭对应功能，不猜字段。
