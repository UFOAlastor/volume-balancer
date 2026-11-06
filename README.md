# Volume Balancer · 网页响度均衡

**简体中文** · [English](README.en.md)

<img src="extension/icon-128.png" alt="Volume Balancer 图标" width="72">

自动平衡网页声音大小，支持 **0–500% 音量**与**逐页控制**。音频在本机处理，界面支持简体中文和英文。

[下载 1.1.2](https://github.com/UFOAlastor/volume-balancer/releases/tag/v1.1.2) · [使用指引](docs/USAGE.md) · [兼容性说明](docs/COMPATIBILITY.md)

## 安装或更新

适用于 **Microsoft Edge 116+**。目前通过 GitHub 安装包手动安装；此发布不代表 Edge 商店已经上架。

1. 在[发布页](https://github.com/UFOAlastor/volume-balancer/releases/tag/v1.1.2)下载 **volume-balancer-1.1.2.zip**，解压到准备长期保留的文件夹。
2. 打开 `edge://extensions/`，开启「开发人员模式」。
3. 点击「加载解压缩的扩展」，选择包含 `manifest.json` 的解压目录。如果下载的是仓库源码，请选择其中的 **extension** 文件夹。
4. 固定 **Volume Balancer** 图标，刷新已有音视频网页，然后正常播放。

**更新：**将新版本解压到原安装目录，在扩展管理页点击「重新加载」，再刷新音视频网页。统一设置会保留；逐页设置在扩展重载、更新或浏览器重启后重置。

## 日常使用

- 默认开启自动响度均衡，新安装默认音量 **100%**；可以独立关闭均衡并继续调节音量。
- 用滑块或快捷档调整统一音量，也可对单个网页静音、调音量、停止或恢复处理。关闭面板后继续生效。
- Bilibili 开始播放后，点击工具栏扩展图标，面板会自动尝试整页接管；失败时可在面板重试。播放器原有的静音和零音量设置仍优先。
- 其他需要整页处理的网页，可使用「当前网页 · 整页接管」。关闭自动模式不会停止已开启的整页接管，需另行停止。

<img src="docs/assets/popup-active.png" alt="中文界面示例：统一音量与逐页控制" width="390">

*上图为早期版本的中文界面示例，当前版本布局可能不同。*

## 使用提示

从舒适音量逐步调整。高增益可能放大底噪、压缩动态；实际增幅取决于音源及峰值限制。停止处理后音量可能变化，若声音异常，请刷新网页后重新播放。

跨域媒体、DRM 和站点限制可能影响处理；部分音源只能调低音量，请以面板状态为准。峰值保护仅作用于可处理音源，不保证系统混音或耳边音量安全。浏览器内部页、扩展页和本地文件请使用原播放器调节。详见[兼容性说明](docs/COMPATIBILITY.md)。

## 隐私与许可

实时音频、媒体状态和网页标题用于本机声音控制与显示，设置保存在本机。可在扩展「关于」查看[隐私说明](extension/privacy.html)与完整许可。

基于 [tyrantqiao/balanceVoice](https://github.com/tyrantqiao/balanceVoice)，原作者 **qiao**。遵循 [MIT 许可](LICENSE)，保留[来源说明](NOTICE.txt)。更多参考项目见[完整致谢](docs/ACKNOWLEDGEMENTS.md)。
