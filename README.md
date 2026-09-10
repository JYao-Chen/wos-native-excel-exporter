# WoS Native Excel Exporter

这是可独立运行的 Node.js 程序：由 Playwright 操作可见 Chromium 中的 WoS 网页，执行检索并点击 Export → Excel，不依赖 GPT、油猴、内部请求重放或 TXT 转换。项目包含检索、网页原生下载、断点续传及合并去重所需的全部代码。

## 环境与启动

需要 Node.js 22 或更新版本、Playwright配套Chromium浏览器，以及当前网络可访问的 WoS Core Collection 订阅权限。程序默认操作英文界面；其他界面语言尚未适配。

在本目录运行：

```sh
npm ci
npx playwright install chromium
node src/export.cjs --config examples/wearsteel.json --out output/wearsteel-001
```

`examples/wearsteel.json` 保存耐磨钢2026-09-04精准正式版的9个完整展开检索式：P1–P8及相关合金对照。与之前相同，不改变词项、文献类型、年份范围或语言范围；不使用另一个会话的 #集合编号。换项目时复制该文件并替换 `queries` 即可。

配置格式：

```json
{
  "url": "https://webofscience.clarivate.cn/wos/woscc/advanced-search",
  "batchSize": 1000,
  "delayMs": 3000,
  "queries": [{"id": "P1", "name": "材料论文", "query": "TS=(\"wear-resistant steel*\") AND DT=(Article OR Review OR \"Proceedings Paper\")"}]
}
```

默认使用独立的持久化浏览器目录 `~/.local/share/wos-native-exporter/profile`，不读取或复制日常 Chrome 的 Cookie，不需要关闭日常浏览器。该目录保存本机登录状态，不应上传或分享。使用 `--profile` 可以指定其他独立目录；同一目录勿同时运行两个程序。

网页若要求登录或验证，程序保留已完成批次并暂停；在可见浏览器人工完成，再到终端按回车，以原命令加 `--resume` 续传。无人值守执行可加 `--non-interactive`，失败后直接保存状态并退出；仍需人工处理登录或验证。

高级检索页明确显示502/503/504服务器错误时，最多等待后重载两次；自定义字段菜单未加载时，在尚未下载的前提下重载原结果页重试一次。不对登录、验证或其他错误盲目重试。

## 原生字段与下载

- 每批重新打开导出窗口，选择 Records from，填写起止范围，并核对控件实际值及网站上限。
- 每批重新选中自定义字段的四个分组及子项，包括参考文献、摘要、关键词、机构、基金等。不能沿用上一批的勾选状态，WoS会重置。
- 在点击 Export 前监听下载事件；下载原始 XLS/XLSX 二进制，不重构、不换扩展名。
- 校验真实 Excel、条数、完整记录字段、UT 和跨批重叠后保存进度。
- 只有全部集合完成才合并。零结果保留检索记录，不把超时、错误页面或验证页面当成0。
- 合并仅按完全相同的 UT 去重，保留首次出现的完整记录及原生列名、列顺序、单元格值。不会按 DOI 合并不同 UT，不新增项目字段。
- 不引入 TXT 的续行；原生字段本身有换行时保留，在来源文件中记录。未自动删除参考文献或地址分隔。

## 输出

- `raw/<集合>/`：网页原生批次和任务清单。
- `WoS-native-merged.xlsx`：原生字段合并去重表。
- `set-membership.csv`：UT对应所有命中集合，分类不混入原生字段。
- `searches.json`：实际执行的完整检索配置。
- `status.json`：已完成数量与最终结果。
- `WoS-native-merged.sources.json`：每条记录的批次来源、重复记录差异、原始换行位置。
- 仅失败时生成 `last-page.png`，供定位登录、验证或页面改版问题。分享前确认截图内容。

新任务使用新输出目录，不覆盖已有交付。续传会重新读取已下载文件，检出缺失、条数错误或字段不一致就停止。未完成集合只在原结果URL仍有效、总数未变化时续传；会话过期时应换新输出目录重跑，避免混合新旧排序批次。

## 测试

```sh
npm test
```

本地测试包括实际 Chromium 的控件操作和二进制下载、每批字段重选、最后不足一批、合并、缺失文件、重复UT、表头变化、HTML错误响应及零结果区分。真实WoS实测结果见 [真实WoS实测记录](docs/LIVE_TEST.md)，与本地模拟测试明确区分。

## 项目结构

```text
src/          检索与网页操作、Excel校验、合并去重
examples/     可复用检索配置
tests/        本地浏览器及数据处理测试（不访问WoS）
vendor/       SheetJS及其Apache-2.0许可证
docs/         真实WoS实测记录
```

## 数据与许可证

仓库不包含论文元数据、原始导出文件、Cookie、登录状态、运行日志或个人账户信息。运行结果默认写入已被Git忽略的 `output/` 目录；浏览器配置请保持在仓库之外。论文数据库的访问及导出须遵守订阅权限和相应服务条款。

本项目当前未授予开源许可证（`UNLICENSED`）。第三方SheetJS CE 0.20.3来自其官方发布包，其Apache-2.0许可证保留在 `vendor/LICENSE`；Playwright通过npm安装，遵循其自身许可证。
