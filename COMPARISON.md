# 跟已有的同类项目比，差在哪

写这份东西的原因很实际：这个品类已经有 6 个能跑的项目，不写清楚区别，别人会默认你是第七个重复的。

数据抓取时间 2026-11-23，来自 npm / PyPI registry 与 GitHub 页面。

| 项目 | 形态 | 30 天下载 | 核心机制 |
|---|---|---|---|
| [crucible](https://github.com/krzemienski/crucible) | Claude Code 插件 | — (1 star) | quorum-approved proof，多验证者投票才算通过 |
| [agent-guardrails](https://github.com/jzOcb/agent-guardrails) | Claude Code skill + git hooks | — | 机械强制项目规范，偏代码风格/流程 |
| [proof-of-done](https://www.npmjs.com/package/proof-of-done) | npm + PyPI + CC 插件 | 316 | 对比前后 diff，检测删测试/跳测试/删断言 |
| [verify-gate-mcp](https://www.npmjs.com/package/verify-gate-mcp) | MCP server | 25 | prover ≠ verifier，任务由一个 agent 声称、另一个验证 |
| [taskattest](https://pypi.org/project/taskattest/) | PyPI | 151 | 检测任务范围外的改动 |
| [mcp-agent-gate](https://pypi.org/project/mcp-agent-gate/) | MCP server | 198 | 确定性检查 + refute-first |
| **no-receipts** | **CLI + 库，零依赖** | — | **三态语义：complete / retry / abort** |

## 真正的差异只有三条

1. **三态而不是二态**。多数同类项目输出 pass/fail 或 allow/deny。这里多一个 `retry`：把结构化 issue 列表原样交回模型再试一次，预算默认 1 次。这直接对应各家 agent 生命周期能力的差异——Claude Code 能硬 block，Cursor 只能 followup 重试。用一个二元答案覆盖两者，必然有一边是错的。

2. **零依赖、不绑宿主**。`crucible`、`agent-guardrails` 是 Claude Code 专用；`verify-gate-mcp` 要求 MCP。这里核心层只依赖 `node:fs` / `node:child_process` / `node:path` / `node:util`，宿主适配层由使用者自己写（`src/cli.ts` 就是一份参考实现，58 行）。

3. **verifier 拒绝猜**。命令没有输出 → `unknown`；未注册的验证类型 → `unknown`；文件路径跳出 `rootDir` → `unknown`。永远不会因为"不知道"而给 pass。会猜的验证器比没有验证器更糟，因为 gate 会信它。

## 明确没有做的

- **不做 diff 比对**（那是 `proof-of-done` 的地盘），这条路线要求把改动前后都喂进来，成本高。
- **不做多验证者投票**（那是 `crucible`），在单人开发场景里投票等于自己跟自己开会。
- **不做 LLM judge**。这个品类的全部价值就在于判断来自确定性检查而非模型。

## 为什么不商业化

6 个项目、30 天下载量加起来不到 1000 次。这个品类真实存在但很小，且用户是"已经在意质量的人"——他们已经会用 git hook、CI、`--strict`。卖订阅在这个人群里转化率极低。开源是它唯一合理的归宿。
