# context-distiller

OpenClaw 的智能上下文蒸馏插件。

`context-distiller` 的目标，是在冗长内容进入上下文窗口之前，先做一层“保留关键信息、压缩无效噪音”的处理，从而减少 token 浪费，提升后续推理质量。

它主要覆盖两条路径：

1. **tool_result_persist** —— 压缩工具输出
2. **before_message_write** —— 对超长 user / assistant 消息做 **Layered Recall**

---

## 这个插件解决什么问题

在 OpenClaw 里，真正吃掉上下文的，往往不是“有用信息”，而是这些东西：
- 大段终端输出
- 测试日志
- 文件列表
- grep 结果
- diff / patch
- JSON / API 响应
- 用户直接粘贴的大段日志或报告

这些内容如果原样进入上下文，很容易带来：
- **上下文溢出**：前面的重要消息被模型静默丢弃
- **推理质量下降**：噪音太多，信号被淹没
- **成本上升**：token 更多，费用更高

`context-distiller` 的作用，就是在这些内容真正进入上下文前，先做一层智能压缩。

---

## 核心能力

### 1. 工具输出压缩
对于冗长的工具输出，插件可以：
- 消除重复
- 提取错误和摘要行
- 总结 JSON / API 响应
- 总结文件列表
- 压缩 diff
- 对 CSV / BibTeX 等结构化内容做专门摘要

### 2. Layered Recall（长消息压缩）
对于超长的 user / assistant 消息，插件不会直接把整段原文塞进上下文，而是生成一个结构化 envelope。

这个 envelope 可能包含：
- **Keypoint Summary**
- **Representative Samples**
- **Section Index**
- **Full-text Access** 指针

它的目标不是“逐字无损保留”，而是让 agent 在有限上下文里，先掌握内容重点，并且保留之后回读原文的能力。

### 3. 内容感知压缩
插件会尝试识别内容类型，例如：
- search results
- API responses
- error-heavy output
- file listings
- environment/config 输出
- docker / kubectl 输出
- 表格数据

不同内容会走不同压缩策略，而不是一刀切截断。

---

## 安装

### 从源码安装
```bash
git clone https://github.com/baixiaodev/claw-context-distiller.git ~/.openclaw/extensions/context-distiller
cd ~/.openclaw/extensions/context-distiller
npm install
```

### 在 openclaw.json 中启用
```json
{
  "plugins": {
    "entries": {
      "context-distiller": {
        "enabled": true,
        "config": {
          "toolOutputMaxTokens": 1200,
          "patchMaxTokens": 600,
          "fileContentMaxTokens": 1000,
          "messageMaxTokens": 3000,
          "messageSummaryMaxLines": 40,
          "aggressiveness": "moderate"
        }
      }
    }
  }
}
```

### 重启 Gateway
```bash
openclaw gateway restart
```

---

## 主要配置项

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `enabled` | `true` | 总开关 |
| `toolOutputMaxTokens` | `1200` | 工具输出压缩阈值 |
| `patchMaxTokens` | `600` | diff / patch 压缩阈值 |
| `fileContentMaxTokens` | `1000` | 文件内容压缩阈值 |
| `messageMaxTokens` | `3000` | Layered Recall 触发阈值 |
| `messageSummaryMaxLines` | `40` | 长消息摘要行数上限 |
| `aggressiveness` | `moderate` | 压缩强度（conservative / moderate / aggressive） |
| `distillModel` | 可选 | LLM 摘要模型覆盖 |
| `distillProvider` | 可选 | LLM provider 覆盖 |

---

## 当前质量指标（内部 benchmark）

长消息质量测试（30 个案例）：

| 指标 | 结果 |
|---|---:|
| Keypoint Summary 覆盖 | 23/30 |
| Representative Samples 覆盖 | 7/30 |
| Multi-section 覆盖 | 30/30 |
| Summary budget 合规 | 30/30 |
| 高信息量 envelope | 13/30 |
| 中等信息量 envelope | 17/30 |
| 弱 envelope | 0/30 |

---

## 已知限制

请参考：
- [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md)
