# Speech 功能

Speech 拥有语音能力调用和 Provider client，不拥有 Chat 消息、媒体资产或播放状态。

Chat 语音消息通过 `startVoiceMessageTranscription` 建立单段转写会话。Chat 与 Calls 都使用 `startRealtimeSpeechToText`，支持腾讯实时 ASR、阿里百炼 Fun-ASR / Paraformer、火山引擎豆包实时 ASR 与阶跃星辰实时 ASR：采集期间接收 16 kHz 单声道 PCM，结束录音后等待最终识别结果。没有文件转写或自动换提供方的路径。调用方消费中间结果、最终结果或稳定失败码。

Speech 的启动错误、会话错误和聊天录音结果保留具体原因，不经过聊天模型的通用错误文案替换。

AI 语音继续复用 `synthesizeTextToSpeech`，consumer 为 `chatVoiceMessage`。生成的临时文件由调用方在 Media backing prepare 完成后清理，Speech 不提交 MediaAsset 或 Chat 事实。

## 提供方与参数

`SpeechProviderCatalog` 持有提供方、官方地址、模型参数和表单校验契约。Assistants 持有模型资产及编辑草稿，负责按提供方渲染下拉选择和参数。新建官方服务不要求填写 URL；自定义 OpenAI 兼容服务保留地址输入。旧配置中的自定义地址保持不变，用户可明确改用官方地址。

火山与阶跃共用 `RealtimeRecognitionSocket` 的握手、取消、错误脱敏和连接释放，具体消息协议仍归各自 adapter；初始化确认前不开始采集，主动取消后不再交付迟到结果。React Native 的网络失败先触发不含详情的 `error`，再通过 `close.reason` 返回原生原因；错误收口由后者负责，不能在前者提前关闭并丢失 HTTP 握手失败信息。

| 实时识别提供方 | 配置与协议 |
| --- | --- |
| 火山引擎（豆包） | 使用语音控制台的 API Key，开通豆包流式语音识别 2.0，选择按时长或按并发规格；无需填写方舟 Endpoint ID。固定 v3 `bigmodel_async` 地址，资源标识由所选规格映射为请求头。PCM 与 JSON 使用官方二进制无压缩协议，每个分句只定稿一次；客户端负序号包结束音频输入，服务端负包才是最后结果屏障。支持按需关闭句末二遍识别纠错。 |
| 阶跃星辰 | API Key 与 `stepaudio-2.5-asr-stream`，固定实时 WebSocket 地址；可配置语言、识别提示与句末二遍纠错。等待 `session.updated` 后发送 PCM；当前模型的 delta 全文替换，定稿使用 transcript，字级时间戳转换为毫秒供通话录音归档。通话启用服务端 VAD 持续断句；单段录音与设置测试使用手动 commit，等实际转写片段的 completed 后完成。created/committed 的提交项 ID 与实际转写片段 ID 不相同，不能把提交项加入待转写集合，也不能将提交确认当作最终文字的额外完成条件。 |

上述接入只增加语音提供方，不增加模型选择层、消息提交路径或文件转写。火山语音 API Key 与方舟文本模型配置属于不同服务，不能根据 `/v3` 路径判断凭据可共用。

协议依据：[火山实时识别 v3](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)、[火山二进制帧说明](https://docs.volcengine.com/docs/doubao-voice/large-model-streaming-automatic-speech-recognition-api-1?lang=zh)、[阶跃双向实时 ASR](https://platform.stepfun.com/docs/zh/api-reference/audio/asr-stream.md)。

TTS 支持 OpenAI、MiniMax、ElevenLabs、Fish Audio、OpenRouter 与自定义 OpenAI 兼容服务。正式调用与设置测试共用 `synthesizeConfiguredSpeech` 和 `SpeechSynthesisGateway`。OpenRouter 的风格指令使用当前官方顶层 `instructions`，只为已声明支持该能力的模型开放。OpenRouter 模型目录与 ElevenLabs 模型/音色目录可从官方接口加载。

Fish Audio 使用原生 `POST /v1/tts`：模型通过 `model` 请求头指定，音色 ID 映射为 `reference_id`，不套用 OpenAI 协议。配置页提供 S2.1-Pro（默认）、S2.1-Pro-Free、S2-Pro、S1 与 Drama 3，以及语速、MP3／WAV、采样温度、Top P、延迟模式和文本读法转换。模型名在统一配置边界校验，避免官方将未知名称替换为默认付费模型。当前接入单音色；S2／S2.1（含免费版）与 Drama 3 开放方括号表达标签，S1 保持普通正文与标点。多说话人、参考音频上传、音标和 Drama 3 成对 XML 控制未开放；聊天、通话和试听继续复用现有模型快照与临时音频生命周期。

表达能力随模型变化：MiniMax 使用 emotion，OpenAI 的 GPT-4o Mini TTS 使用 instructions，Eleven v3/v4 使用音频表达标签。Eleven v4 不发送 style、speed 或 speaker boost；其他已接入 Eleven 模型的 speed 范围为 0.7～1.2。Chat 的 `createConfiguredVoiceMessageTool` 在每次 run 准备时固定角色 TTS 模型、工具 schema 和文本说明，只向 AI 暴露实际支持的表达参数；执行继续使用同一快照。

### 语气词、声音与停顿

自然语气词“嗯、啊、唔”和标点属于正文。`SpeechText` 拥有已核对模型的句内标记契约，并在模型输出边界生成合成输入与 canonical 转写；模型支持的标记保留，不支持但格式完整的标记移除，让剩余正文继续合成，不转换为其他厂商语法，也不把标签当作正文朗读。非法、不完整或嵌套的标记，以及当前模型停顿语法中的无效时长和位置仍报错。Chat 与 Calls 复用同一契约，不在 Provider adapter 重复校验内部数据。

| 提供方 / 模型 | 当前开放的表达 |
| --- | --- |
| OpenAI GPT-4o Mini TTS，以及 OpenRouter 的对应 OpenAI 模型 | 正文使用自然语言和标点；Chat 可用独立 instructions 指导情绪、轻声和节奏，不承诺精确停顿或指定非语言声音。Calls 使用配置默认风格。 |
| OpenAI tts-1 / tts-1-hd | 正文与 speed，无 instructions 或句内控制标记。 |
| MiniMax speech-2.8-hd / turbo | emotion、speed；句内 `<#0.5#>` 停顿与官方 `(laughs)`、`(breath)`、`(sighs)` 等声音标记。 |
| MiniMax speech-2.6、speech-02 的 hd / turbo | emotion、speed 与 `<#0.5#>` 停顿，不开放 2.8 的声音标记；仅 2.6 支持 fluent / whisper 情绪值。 |
| Eleven v3 / v4 / v4 turbo | 支持符合语法的任意自然语言 Audio Tags，由 AI 按情境自主决定是否使用及标签内容；`[whispers]`、`[laughs]`、`[short pause]` 等仅为示例，不是白名单。不使用 SSML break。标签与音色匹配会影响实际效果，不是精确计时。 |
| Fish S2-Pro / S2.1-Pro / S2.1-Pro-Free / Drama 3 | 支持自然语言方括号表达标签，提示词给出 `[happy]`、`[whispering]`、`[laughing]` 及完整句子示例，不限制为这些词。`[break]`、`[long-break]` 表达相对停顿；不承诺秒数，不使用 S1 圆括号、音标、说话人或成对 XML。 |
| Eleven multilingual v2 / flash v2.5 / turbo v2.5 | 自然正文、speed 与 `<break time="0.5s" />`，停顿大于 0 且不超过 3 秒；不开放 v3/v4 的方括号标签。 |
| OpenRouter Voxtral、自定义 OpenAI 兼容服务、动态目录中的未知模型 | 不因兼容接口或厂商名称推断句内控制能力；AI 只获得自然正文和标点规则。自定义服务的用户连接参数仍由其配置决定。 |

Fish 的方括号语法与自然语言描述以[官方表达文档](https://docs.fish.audio/developer-guide/core-features/emotions)和 [Drama 3 文档](https://docs.fish.audio/features/text-to-speech/drama-3)为依据。配置为自定义 OpenAI 兼容服务时，即使模型名含 Fish，也不自动赋予这些能力。

MiniMax 停顿范围为 0.01～99.99 秒，最多两位小数，必须位于可朗读正文之间且不能连续使用。音标、发音字典、多说话人和背景音不在当前文本契约中。

Eleven 与 Fish 的方括号 Audio Tags 共用语法边界：接受配对的半角 `[标签]`、全角 `［标签］` 和方头 `【标签】`，统一为半角括号，去除标签首尾空格并将内部连续空格统一成一个半角空格；正文与中文标点不参与标签规范化。每个标签去除首尾空格后为 1～100 个 Unicode 字符，至少包含文字或数字；允许文字、组合音标、数字、空格，以及引号、逗号、句号、问号、感叹号、冒号、分号、顿号、省略号、连字符和破折号。不允许嵌套、括号不匹配、未闭合、换行、控制字符或其他符号。不支持 Audio Tags 的模型移除符合该语法的标签；其他完整的圆括号声音标记、XML 包装和跨厂商停顿标记同样按模型能力保留或移除，XML 内的正文保留。移除时保留词间空白，避免英文词被拼接。`synthesisText` 进入 TTS，去标签的 `transcript` 进入消息、字幕与通话事实。Fish 的 `[break]`／`[long-break]` 在通话分句中与两侧正文同次合成，避免停顿成为没有可朗读正文的独立片段。

纯声音标签语音消息暂不开放：去除标签后为空仍报错，不调用 TTS。是否允许没有可朗读正文的声音消息属于独立产品决定，需要另行确定转写、预览和上下文应表达什么，不能随标签语法放宽一并改变。

实时通话每轮固定角色 TTS 模型，提示词、流式分句、验证与播放共用该快照。分句器等待句末的文本后继或流结束确认边界，完整保留跨 delta 的标记；句间显式停顿把两侧正文合并为一个合成单元。`aiSpeechText`、TTS 播放事件和字幕只使用转写，控制标记只进入 TTS 输入；播放队列信任已经验证的句子。来电邀请的持久开场白和去电接听决策仍是纯正文，可使用自然语气词和标点；接通后的实时回复才声明厂商句内能力。

## 设置测试

`SpeechConfigurationTest` 使用经过同一表单边界校验的连接快照，不保存测试文本，不改变系统或角色的模型选择，不创建消息或媒体资产。TTS 支持修改测试文本、生成、播放、暂停；STT 支持填写预期文本、麦克风实时识别与等待最终结果。切换配置或离开页面时取消连接，释放麦克风、播放器并删除临时音频；迟到的结果也必须清理。

Fish、OpenAI 兼容、MiniMax 和 ElevenLabs 语音接口的 HTTP 失败保留状态码、`error.message` 或顶层 `message`，并在现有错误信息中附上响应正文，便于区分地址、音色与服务端错误。非 JSON 响应同样保留原文；当前配置的 API Key（包括 JSON 和 URL 转义形式）在 HTTP 边界脱敏，不输出请求头或额外记录日志。测试页的错误文字可长按选择和复制。MiniMax 的业务失败保留 `base_resp.status_code` 与描述；实时 STT 保留 Provider 错误码、原生 WebSocket 错误原因及非正常关闭的 code/reason。通话中的 TTS/STT 失败沿同一错误事实立即显示，文本模型 HTTP 诊断不采集语音请求。

新增提供方只需添加参数定义与真实协议适配，然后注册到现有入口；Chat、Calls 和测试页不判断具体协议。不支持的官方参数不包装成万能 JSON 输入，实时 STT 也不接受文件转写服务来凑提供方数量。

官方协议参考：[OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech)、[OpenRouter TTS](https://openrouter.ai/docs/guides/overview/multimodal/tts)、[MiniMax T2A](https://platform.minimax.io/docs/api-reference/speech-t2a-http)、[ElevenLabs TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)、[ElevenLabs 表达与停顿](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)、[Fish Audio TTS](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)、[Mistral Voxtral TTS](https://docs.mistral.ai/studio/audio/text_to_speech/speech)、[阿里实时 ASR](https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api)。

`npm run verify:speech` 验证请求、参数、配置提交、实时完成屏障与测试生命周期；真实鉴权、发音质量与 Android 采集/播放仍需要对应密钥和设备验收。

## 模型选择

STT 选择由 Speech 保存于 `speech_recognition_settings`，所有角色的聊天录音与通话共用。未选择时提示配置模型，失效引用提示检查或重新选择。「辅助模型中心 → STT 模型」列表顶部直接嵌入 `SpeechRecognitionModelPicker`，选后立即保存，不增加设置页跳转。角色模型设置不再提供语音识别模型选择。原「我 → 语音识别设置」入口与独立页面已移除，已有选择不变；consumer 只表达场景，不参与模型选择。
TTS 由 Assistants 保存角色明确选择，语音消息和通话共用该角色模型；未选择或失效不会继承全局默认。
首次 STT 配置可用后初始化全局选择；首次 TTS 配置可用后初始化已有角色的空白设置，新角色创建时也固化该首次模型的可用引用。更换或取消后不自动覆盖。Host 通过 composition 出口装配各 owner 的初始化、选择和资产解析。当前契约见 [模型选择架构](../../../docs/architecture/auxiliary-model-selection.md)。
