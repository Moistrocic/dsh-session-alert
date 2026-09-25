# CONTEXT — dsh-session-alert

本项目的共享语言。**只是词汇表**：不含实现细节，不含规格，不做草稿本。

## 术语

### Attention Event（待办事件）

本插件存在的唯一理由所要宣告的原子单位：**某个 Session 进入了需要用户介入的状态。**
它由四类上游 DSH 事实之一触发——一轮回复结束、一轮出错、工具等待授权、Agent 提出结构化提问——并且是投递侧唯一见到的输入。

Attention Event 不是 DSH 的事件，也不是一条通知；它是本项目自己的意义单位。若干个 DSH 事件可能合并成一个 Attention Event，也可能不合并（见「合并」）。

### Session（会话）

一个 DSH Session。并非每个 Session 都是**可通知的**：本插件区分**根会话**与那些仅为服务于它而存在的会话。

### Root Session（根会话）

能够产生 Attention Event 的 Session。其补集——子代理、workflow 子会话，以及其他服务性会话——被刻意保持沉默，因为一次 fan-out 就能拉起十几个。

### Client Kind（端别）

挂接到 Host 上的**哪一类**界面：**`web`** 或 **`desktop`**。恰好两类，且这一区分是**范畴性的**——不按窗口、不按进程。`web` 与 `desktop` 可以**同时**挂接，且 `web` 可以同时挂接多个。

### Client Presence（端在线）

某一 Client Kind 至少有一个客户端当前挂接这一事实。存在性按端别计，因此最多是两个成员构成的集合，**不是窗口计数**。

### Coalescing（合并）

把若干上游 DSH 事实折叠成一个 Attention Event（或把若干 Attention Event 折叠成一次宣告），使用户在短窗口内不会反复被告知同一件事。

### Delivery Channel（投递通道）

把 Attention Event 呈现给用户的 Windows 机制。通道有顺序、可替换；插件的意义不依赖于哪一条通道触发。

### Suppression（抑制）

**仅限 desktop 端**的行为：因为用户已经在看应用，而扣下通知**卡片**。抑制只扣卡片，**从不扣提示音**。抑制是一项设置，且**在 web 端完全不存在**。

### Focus（焦点）

DSH 应用当前是否持有前台。焦点是有关 desktop 客户端的独有事实，也是抑制的输入。

### Chime（提示音）

宣告中的听觉部分，与卡片分离。无论卡片是否发出，提示音都会响；它存在的意义是触达**人在机器前、但注意力不在机器上**的用户。

### Notification Template（通知模板）

宣告内容的用户可编辑定义。模板由字面文本与**变量**组成，用户控制哪些变量出现、以什么顺序出现。

### Variable（变量）

触发该 Attention Event 的 Session 的一项可替换事实（哪个会话、哪类事件、何时发生等），通知模板可在任意位置引用。
