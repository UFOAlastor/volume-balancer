# 来源、致谢与参考资料

感谢以下项目的作者和文档维护者。本页区分上游代码来源、功能研究参考及算法资料；列入致谢不表示这些项目为 Volume Balancer 背书，也不表示本扩展具有它们的全部功能。

## 上游代码与完整许可

Volume Balancer 是 [tyrantqiao/balanceVoice](https://github.com/tyrantqiao/balanceVoice) 的独立修改版本，原作者 **qiao**。保留的基线为 [`e043e8e880b85ce53443fea0c754b662eb2fced7`](https://github.com/tyrantqiao/balanceVoice/tree/e043e8e880b85ce53443fea0c754b662eb2fced7)。

Copyright (c) 2026 qiao

完整 [MIT 许可](../LICENSE) 与[来源及修改说明](../NOTICE.txt) 同时保存在源码和扩展目录中。界面或功能变化不改变该来源与许可保留要求。

## 实际查阅的同类项目

这些项目用于理解和比较音色预设、操作方式及音乐动态策略。现有研究记录未将其代码引入产品，也没有原样采用其预设参数；这里是研究致谢，不将它们列为安装依赖或新增许可义务。

| 项目与实际查阅入口 | 参考范围 |
| --- | --- |
| [EffeTune：Tone Control](https://github.com/Frieve-A/effetune/blob/main/plugins/eq/tone_control.js)、[盲测说明](https://github.com/Frieve-A/effetune/blob/main/docs/double-blind-test.md)、[crossfeed](https://github.com/Frieve-A/effetune/blob/main/plugins/spatial/crossfeed_filter.js) | 少量音调控制、比较方法与耳机交叉馈送研究；本扩展没有提供盲测工具或 crossfeed。 |
| [Umbra：内置预设](https://github.com/skyjacc/Umbra/blob/main/src/lib/builtins.ts) | 有限的人声、音乐音色选项及预设交互。 |
| [KoalaSound：预设与面板](https://github.com/Shik3i/KoalaSound/blob/main/extension/popup.js) | 用固定预设降低调节负担的方式。 |
| [AutoEq：项目说明](https://github.com/jaakkopasanen/AutoEq/blob/master/README.md) | 区分特定耳机测量校正与通用音色偏好；本扩展未提供耳机数据库或校正导入。 |
| [Volume Control：Music 与 Adaptive 模式](https://github.com/Chaython/volumecontrol/blob/master/README.md) | 音乐动态保留与自动调平策略的研究对照；本扩展未加入独立的音乐调平模式。 |

人声与音乐音色实验保留在 `experiments/rc6-tone/`，当前发行包不提供这些功能。实验尚未完成听感验收；研究中的站点音色规则、单声道辅助、crossfeed 等建议同样不属于当前功能。

## 算法与平台资料

- [W3C Audio EQ Cookbook](https://www.w3.org/TR/audio-eq-cookbook/)：滤波公式参考。该文档由 Robert Bristow-Johnson 的 Audio-EQ-Cookbook 改编，编辑为 Raymond Toy；文档适用 W3C permissive document license。产品滤波实现为项目内编写，没有引入第三方产品 DSP 代码。
- [W3C Web Audio 1.0](https://www.w3.org/TR/webaudio-1.0/)：滤波参数、音频处理及平台行为参考。

## 其他已查阅、未集成的方案

下列资料用于比较方案与确定边界，属于文档研究参考；没有集成其代码、模型或插件。商业产品手册不构成对其实现的复制授权。

- [FabFilter Pro-Q 动态 EQ](https://www.fabfilter.com/help/pro-q/using/dynamic-eq) 与 [TDR NOVA 手册](https://docs.tokyodawn.net/nova-manual/)：动态均衡研究；动态原型仍在实验目录，未替换产品音色方案。
- [RNNoise](https://github.com/xiph/rnnoise/blob/main/README)、[WebRTC Audio Processing](https://webrtc.googlesource.com/src/+/refs/heads/main/api/audio/audio_processing.h) 与 [Speex 预处理器说明](https://www.speex.org/docs/manual/speex-manual/node4.html)：通信语音处理的用途与限制；本扩展未加入降噪、回声消除或模型服务。
- [FabFilter Pro-L 2 输出选项](https://www.fabfilter.com/help/pro-l/using/outputoptions) 与 [Ableton Live Limiter 手册](https://www.ableton.com/en/manual/live-audio-effect-reference/#limiter)：峰值保护的功能与说明方式对照；不表示本扩展达到其处理效果或提供 true-peak 限制。
