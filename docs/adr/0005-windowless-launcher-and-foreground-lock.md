# ADR 0005 — 用无控制台的外部启动器置顶，并接受前台锁的限制

状态：已接受

## 背景

卡片点击后要把 DSH 窗口还原并提到前台。实测暴露了两件必须分别处理的事：

1. **进程启动方式不能分配控制台**（见 [ADR 0004](./0004-no-console-allocation.md)）。
2. **Windows 前台锁会按设计拒绝前台切换**，且这与实现方式无关。

同时，由 `conhost.exe --headless` 包住 PowerShell 的写法虽然解决了控制台分配，却引入
一个**无窗口的中间进程**；`AllowSetForegroundWindow` 返回 `True`（拿到激活授权）时，
焦点该转给谁并不明确。

## 决定

### 一、用一个编译成 GUI 子系统的外部启动器，不经 PowerShell、不经 conhost

启动器是一个 C# 小程序，以 `/target:winexe` 编译。这样：

- **子系统为 Windows（PE Subsystem = 2）**，因此**根本不分配控制台**，没有闪烁；
- **中间没有 conhost 这一层无窗口进程**，激活授权直接落在启动器自身；
- 启动器自己持有可操作的窗口目标，无需 `-EncodedCommand` 这类仅为绕开参数编码而存在
  的机制。

这个启动器在安装时**一次性编译**并随包分发，不在每次点击时编译。

### 二、把「可见」与「前台焦点」分成两件事——前者可靠，后者按设计被拒绝

**这是本 ADR 最重要的一条，也是踩了很多次坑之后才看清的。**

最初把「把窗口弄到用户眼前」当成一个目标，于是反复尝试各种「取得前台焦点」的手法，全部
失败。真正的原因是这两个目标的可达成性完全不同：

| 目标 | 可达成性 | 机制 |
| --- | --- | --- |
| 窗口**可见地出现在最上层**（用户能看见它） | **可靠** | `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE \| SWP_NOMOVE \| SWP_NOSIZE \| SWP_SHOWWINDOW)` |
| 窗口**取得前台焦点**（用户可直接打字） | **按设计被拒绝** | 需要 `SetForegroundWindow`，受前台锁限制 |

微软的 [`SetForegroundWindow` 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)
明确写着：*"An application cannot force a window to the foreground while the user is
working with another window. Instead, Windows flashes the taskbar button."*
而它**自己的示例**正是把两件事分开做：先 `SetWindowPos(..., SWP_NOACTIVATE)` 让窗口可见
且置顶，只有确实需要焦点时才另外调 `SetForegroundWindow`。这条「可见但无焦点」的路径
**不触发前台锁**。

**实测（用户正在 Chrome 里工作、前台锁生效、且从命令行直接运行因而没有任何激活权——
条件最差的情形）：**

```
foregroundPid(before) = 14064            （Chrome 持有前台）
SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE|SWP_SHOWWINDOW) = True
用户确认：DSH 窗口出现在 Chrome 之上，约 10 秒可见
rect 158x26 -> 1721x927                  （尺寸语义正确）
```

### 端到端：点击通知按钮后，窗口确实出现在最上层（用户确认）

上面是「从命令行运行」的结果。**关键的一步是把它接到真实的按钮点击上**，也已实测通过：

```
15:59:02      通知弹出（DSH 已最小化，Chrome 持有前台）
15:59:04.292  invoked; args=[dshalertclick://open/?session=click-test-1 | --hold | 15]
15:59:04.294  sessionId='click-test-1'                    （会话 id 解析正确）
15:59:04.752  SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE|SWP_SHOWWINDOW) = True
15:59:05.061  HOLD begin: 窗口将保持最上层 15 秒
              用户确认：DSH 窗口出现在 Chrome 之上，约 15 秒
15:59:20.071  HOLD end: SetWindowPos(HWND_NOTOPMOST) = True
```

注意其中一点：**整个过程 `foregroundPid` 始终是 shell 宿主，不是 DSH**——前台锁确实没有
放行。而窗口照样出现在了最上层。这正是本决定的价值：**核心需求不依赖前台焦点。**

**在本项目里，「用户能看见窗口」就是实际需求**（点通知 → 看到哪个会话需要我）。
因此这条可靠路径足以支撑核心功能；前台焦点只是一个可选的加分项。

### 三、`AllowSetForegroundWindow` 的转交是不可依赖的

曾尝试「由被激活的启动器把前台权转交给 DSH，再由 DSH 自己置顶」。实测**首次成功、
复现失败**，原因在文档里有明确说明：

> The process specified by the *dwProcessId* parameter to **AllowSetForegroundWindow**
> **loses the ability to set the foreground window the next time that either the user
> generates input**, unless the input is directed at that process.

即：转交出去的权利会被用户的**下一条输入**撤销。这不是随机失败，而是机制本身如此。
**因此不把该方案作为设计基础。**

### 四、置顶是尽力而为，且不得成为功能可用性的前提

- 前台焦点是**尽力而为**：`SetForegroundWindow` 成功则更好，失败不算缺陷；
- **功能的可用性建立在第二节那条可靠路径上**，而不是建立在抢焦点上；
- 失败时**静默降级**，并在日志里明确记录（`raised=false`），以便与真实故障区分；
- **不采用**任何绕过前台锁的侵入性手段（`AttachThreadInput`、模拟输入等），实测无效，
  且其目的与 Windows 保护用户当前活动的设计意图相悖。

### 五、置顶必须可逆

`HWND_TOPMOST` 会让窗口**长期**压在其他窗口之上，若不复位会持续干扰用户。
因此使用后必须 `SetWindowPos(HWND_NOTOPMOST, ...)` 还原。实测复位调用返回 `True`，
且用户观察到的可见期与设定的保持时长一致。

**关于「置顶后前台归属会变成 DSH」这一现象：** 实测中出现过，但它**不可靠**
（同一配置下也出现过前台停留在 Chrome 的情况）。因此**不作为设计依据**，
只作为附带观察记录，验收时也不据此判定成败。

### 六、还原与置顶是两件事，必须分开判定

**还原是硬要求，置顶是尽力而为。** 实测两者结果独立：前台锁拒绝切换时，窗口仍然
被正确还原（`158x26 → 1721x927`，保持最大化形态，尺寸语义正确）。

把两者混成一个「成功/失败」结论会掩盖真实缺陷——置顶失败会被误读成还原也坏了。

## 后果

- 插件的安装步骤里多一步：编译（或分发预编译的）启动器。这是为「无控制台 + 无中间进程」
  付出的代价，而这两点都无法用纯 PowerShell 同时满足。
- 启动器是一个二进制产物。它必须随包分发且可被校验，不能指望用户本机有 C# 编译器——
  编译只是**开发/安装时**的一次性动作。
- 协议方案的处理程序命令形如 `"<路径>\dsh-focus.exe" "%1"`，不带 `conhost`、
  不带 `powershell`。启动器自行从 URL 里解析会话 id——**不能只认 `--session` 这类开关**：
  协议激活传进来的就是原始 URL（实测形如 `dshalert://open/?session=xxx`，且系统会做
  规范化，例如补上结尾斜杠）。
- **置顶必须可逆**：`HWND_TOPMOST` 不复位会长期压住其他窗口，用后必须
  `HWND_NOTOPMOST`。
- **验收判据要落在可靠的那条路径上**（窗口可见地出现在最上层、尺寸不变），
  而不是落在抢焦点上；抢焦点只作为附带观察记录，不据此判定成败。

## 考虑过的替代方案

- **纯 PowerShell + `conhost --headless`。** 已否决：不分配控制台这一点合格，但引入了
  无窗口中间进程，且需要 `-EncodedCommand` 绕参数编码；也未解决焦点问题。
- **`-WindowStyle Hidden` 或 `wscript` 启动器。** 已否决：实测仍会分配控制台，
  用户能看到一闪（见 ADR 0004）。
- **靠 `AllowSetForegroundWindow` 转交前台权，再由 DSH 自己置顶。** 已否决：实测首次
  成功、复现失败；文档说明该权利会被用户的**下一条输入**撤销，机制本身不可依赖。
- **强行绕过前台锁**（`AttachThreadInput`、反复抢、模拟输入等）。已否决：实测无效，
  且其目的与 Windows 保护用户当前活动的设计意图相悖。
- **放弃把窗口弄到用户眼前，只发通知。** 已否决：`SetWindowPos` 那条可靠路径实测有效，
  放弃它会让功能明显变弱。
