# 验证自动处理与故障恢复

从仓库根目录运行。需要已安装的 Microsoft Edge 和 Node.js；本次使用 macOS、Edge 156.0.4314.58、Node 26.8.2。脚本不安装浏览器或依赖，也不连接现有用户配置。

```sh
node verification/browser-observer-regression.mjs --headless --silent-sink --user-gesture
node verification/browser-control-regression.mjs --headless --silent-sink --user-gesture
node verification/browser-faults.mjs --headless --silent-sink --user-gesture
node verification/browser-automatic.mjs --headless --silent-sink --user-gesture --interactions --switch-video
```

输出默认位于 `verification-output/`。可分别用 `REGRESSION_OUTPUT`、`FAULT_OUTPUT`、`SITES_EVIDENCE` 指定新目录，避免覆盖之前的证据。`EXTENSION_PATH` 可指定冻结安装包解出的扩展目录。实际网站验证需要联网；登录或访问限制不应绕过。

`--user-gesture` 保留浏览器正常的自动播放策略，脚本通过测试网页自己的播放/静音控件进行可信输入；它不会授予扩展 action 或 tabCapture 权限。`--silent-sink` 仅禁用这个临时浏览器的物理音频输出，不更改系统音量。最终门控后的数字 PCM 不等于人工试听或物理回录。

观察器在独立临时测试副本中前置于 `automatic.js`，由浏览器的 document_start 内容脚本顺序保证每次导航先安装。原安装包的 29 个程序/资源文件逐字节校验不变；测试 manifest 只增加这一个观察脚本，版本、权限和其他字段保持一致。正式 ZIP 不包含观察器。真实站点测试不启用 Debugger，不改播放器时钟，也不增加扩展权限。这个带观察器的副本属于仪器化测试，不等于原始安装包完全未改动的实测；原始 ZIP 应另做基础回归。

第一个脚本确定性地证明：音频已在输出时才安装 connect 探针，会漏掉现有音频图。另有只在自有夹具启用的调试对照，证明调试域会让普通 debugger 语句阻断页面执行；真实站点观察器不使用调试域。它还暂停独立测试页的所有 JavaScript，记录恢复租约过期但代码无法执行的边界，再恢复页面并验证音量恢复。该实验模拟页面冻结，不等于操作系统强制终止所有进程。

第二个脚本把丢失指标、丢失心跳、处理器退出、AudioContext 暂停分别与正常音量、用户主动静音、用户零音量组合，并核对底层音量、最终输出、网站记忆和迟到回调。

输入回归使用自有平滑滚动与点击去抖夹具，验证旧坐标未命中时不能算作已操作；新工具确认命中、可信事件送达及状态改变。它是输入工具回归，不算音频输出证据。

第三个脚本验证 Bilibili、YouTube 和第三站公开 MP4。B站和 YouTube 的交互项包括实际音量拖动、静音、停止、切换视频、卸载及刷新后的记忆。网站按钮和视频可随时间变化；无法访问或无法观测时应报告失败，不得把未知结果算通过。
