# VPNCheap Issue 中文与分诊规范

适用范围：`fengqunX` 名下由 [VPNCheap 产品问题中心](https://github.com/users/fengqunX/projects/1) 治理的 12 个仓库。

## 事实源与语言

- 原仓库 Issue 是唯一事实源。Project 只做跨仓视图，不复制 Issue。
- 本轮触及、继续保留或新建的 Issue 使用简体中文，短句，面向非工程管理者。
- 技术缩写首次出现时给出中文解释。三步以上状态机或数据流可用小型 ASCII 图；简单问题不用。
- 不自动翻译。机器检查不得判断技术事实、关闭 Issue 或改写结论。

## 标题与正文

标题固定为：

```text
【平台｜模块】一句话问题
```

正文固定为：

```markdown
## 一句话问题

## 用户影响

## 当前证据

## 复现步骤

## 期望结果

## 验收标准

## 相关链接
```

正文改写必须保留历史。需要归档原描述时使用：

```html
<details>
<summary>原始描述（归档）</summary>

脱敏后的必要原文；删除凭据、客户隐私、入口地址、端口、节点协议和原始敏感日志

</details>
```

已有稳定 CEO 简报时，只放链接和一句用途，不粘贴 HTML 源码，也不为每个小问题新建简报。

## 四类分诊

| 分类 | Issue 状态 | Project Status | 证据要求 |
|---|---|---|---|
| `CLOSE_COMPLETED` | 关闭，`state_reason=completed` | `Done` | 修复仍存在于当前默认分支；已合并 PR/SHA 只作可追溯证据，不能替代当前代码核验。评论写 PR/SHA、验证边界、重开条件。未发布时必须写“代码已合并，用户版本未证”。 |
| `CLOSE_NOT_PLANNED` | 关闭，`state_reason=not_planned` | `Done` | 已确认旧架构、过期需求、无效或重复；重复项链接唯一 canonical Issue；评论写当前证据和重开条件。 |
| `KEEP_VALID` | 保持 open | `Triaged`、`Planned`、`In progress` 或 `Verify` | 当前缺口有直接证据；正文写可执行验收标准；补齐平台、运行时、界面、类型、优先级。 |
| `NEEDS_INFO` | 保持 open | `Needs info` | 证据不足；中文列出平台、版本、截图或脱敏日志、逐步复现方法。 |

不得因年龄单独关闭。安全、支付、数据丢失、跨账号、空节点等高风险问题，没有直接证据不得关闭。

## 标签与 Project 字段

- 平台：`platform:*`；运行时：`runtime:*`；界面：`surface:*`；类型：`type:*`。
- 每条 Issue 只能有一个已知 `runtime:*` 和一个已知 `type:*`；冲突时加 `taxonomy-conflict`，Project 设为 `Needs info`。
- `Priority` 只写 Project 字段：`P0` 停止发布/安全/严重影响，`P1` 高影响，`P2` 普通，`P3` 低优先级。
- `Customer reports count` 与 `Last report date` 只在有可核验证据时填写。
- Project 状态不能替代原 Issue 的 open/closed 状态。

## 写入与关闭门槛

每次 GitHub 写入前记录 exact target：仓库、Issue 编号、当前状态、拟改标题/正文/标签/Project 字段，以及关闭原因。每次写入后重新读取原 Issue 与 Project item 验证。单条失败不阻断其余条目，但必须进入审计台账。

关闭评论至少回答：

1. 为什么现在可以关闭；
2. 哪个 PR/SHA 或当前源码支持结论；
3. 验证到代码、CI、发布还是用户设备哪一层；
4. 出现什么新证据时可以重开。

## 隐私与产品边界

- 禁止写入任何凭据或秘密，包括密码、API 密钥、token、Cookie、证书和私钥；也禁止写入客户隐私、入口 IP、端口、节点协议或敏感日志。
- 日志、截图和报错必须脱敏；只保留证明结论所需的最小内容。
- 不在 Issue 标题、正文、评论、标签、Project 字段或外部简报暴露上述信息。

## 表单与自动检查

`vpncheap-app/.github/ISSUE_TEMPLATE/` 的 Issue Forms 收集平台、版本、复现步骤和截图等结构化信息。英文表单只作为输入辅助；人工分诊后，保留项按本规范改成简体中文。其他仓库采用同一信息标准；缺项时保持 open，由人工分诊设 `Needs info`。

若以后增加自动检查，只能按可解析的必填字段和固定标签确定性标记 `Needs info`。禁止用大型语言模型（LLM）、定时任务、自动翻译或“问题年龄”作为正确性或关闭路径。
