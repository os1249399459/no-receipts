# no-receipts — 发布清单

一页纸，按顺序做。每一步都写了为什么。

---

## 0. 命名决策（已定）

**`no-receipts`**，命令行 `npx no-receipts`。

三轮改名，记录一下为什么：

| 候选 | 淘汰原因 |
|---|---|
| `claimgate` | 要读完 README 才知道干什么 |
| `done-gate` | 功能描述准确，但 "gate" 在这个领域已被用烂（`proofgate`、`evidence-gate`、`mcp-agent-gate`、`verify-gate-mcp`），传播上等于隐形 |
| **`no-receipts`** | **是一句态度，不是一个功能名**。记不住功能名，记得住态度 |

`no-receipts` 直接引用英文里那句 "no receipts, no done"——意思是不出示凭据就不算数，本身就是 hooks 的天然标语。README 副标题已写：*No receipts, no done.*

**命名的实际功能**：`done-gate` 会被搜到，`no-receipts` 会被**复述**。前者靠 SEO，后者靠口口相传——而这个品类的 6 个竞品全挤在 SEO 赛道。

npm `no-receipts` **404 可用**（2026-11-23 实测，GitHub 同名仓库亦可用）。命令名用 `no-receipts` 而不是 `receipts`，因为 npm 上 `receipts` 已被 2015 年的包占用，`npx receipts` 会装错东西。

已被占用、不要用：`done-gate`（自己用过，已弃）、`evidence-gate`、`proofgate`、`vouch`、`notary`、`attest`、`quorum`、`evidence`（全部 npm 已占）。

## 1. GitHub 仓库元数据（这一条最关键）

搜索和 feed 的第一道筛选是**仓库 description + topics**，不是 README。竞品证明：`agent-guardrails` 挂了 10 个 topic，`crucible` 一个都没挂。

**Description**（160 字符内，必须包含会被搜的词）：

```
Blocks coding agents from saying "done" when the claim isn't backed by a tool call that actually succeeded. Zero-dependency CLI + library.
```

**Topics**（GitHub 上限 20，全部填满）：

```
ai-agents  agentic-coding  claude-code  cursor  codex  mcp  llm
hallucination  verification  guardrails  ai-safety  completion-gate
false-completion  claim-verification  developer-tools  devtools
cli  typescript  quality-assurance  prompt-engineering
```

选择逻辑：前 7 个是"人所在的池子"（`claude-code` / `mcp` 的 topic 页是主要流量入口），中间 6 个是"问题词"（`hallucination`、`false-completion` 才是别人会搜的词），最后 7 个是分类词。

## 2. 让它进 feed 的实际机制

说清楚一件事：**GitHub 没有"feed 推荐"，只有 Trending 榜和 topic 页**。所谓"进开发者 feed"只有三条路，按性价比排序：

| 路径 | 机制 | 现实门槛 |
|---|---|---|
| **GitHub Trending** | 以**首日 star 增速**为主，新仓库有加成 | 首日 20–50 star 才有机会上日榜；纯自然增长几乎不可能 |
| **topic 页 / 搜索** | 长期被动流量，靠 topics + description 命中 | 立刻生效，但量小 |
| **HN / Reddit / X** | 真正的流量爆发点 | 需要内容，见下 |

所以顺序是：**先做 HN/Reddit 拿到首日 star → Trending 才有戏 → Trending 反过来带来持续流量**。反过来做（先等 Trending）不会有结果。

## 3. 首发渠道与时机

按 [Show HN 的实战经验](https://dev.to/whoffagents/how-to-launch-on-show-hn-what-actually-works-fel) 与 [多渠道发布清单](https://github.com/curiositech/windags-skills/blob/main/skills/tech-launch-channels/SKILL.md)：

**Hacker News（主力）**
- 标题格式必须 `Show HN: no-receipts – Stop your coding agent from faking "done"`（冒号全角/半角无所谓，但**不能有 "Introducing"、"revolutionary"**）
- 时间：**周二/周三/周四，美东 6:00–8:00 AM**（北京时间 19:00–21:00）
- 立刻自己在帖子里发第一条评论：你是谁、为什么做、技术上怎么做的、和 crucible 这类已有项目的区别、你想听什么反馈
- 前 2 小时回复每一条评论；被批评时先找同意的那部分

**Reddit（第二梯队，注意规则）**
- `r/ClaudeAI`、`r/ChatGPTCoding`、`r/AI_Agents`：允许分享但要**先有 4 条以上的真实技术贡献**（Reddit 9:1 原则），否则算 spam
- `r/SideProject`：最宽容，适合第一发
- `r/programming`：**禁止直接推广**，只能写"我遇到的问题和我怎么解决的"，工具作为附带引用
- `r/selfhosted` / `r/opensource`：开源身份在这里加分最多

**不要做**：Product Hunt（面向消费者，工具类回报低）、买 star、找朋友集中点赞（HN 能检测投票环）。

## 4. 首发之前必须补的三样东西

1. **一个能直接跑的 60 秒 demo**：`npx no-receipts demo`，输出"agent 说 done → gate 拦住 → 打印为什么"。现在只有 `npx no-receipts claims.json`，需要自备 JSON，摩擦太大。
2. **一张对比表**：明确写和 `crucible`、`agent-guardrails`、`proof-of-done` 的差异。不写别人会以为你是第七个重复的。你的差异点是 **suspend/abort 语义（三态，不是 pass/fail）+ 零依赖 + 不绑单一宿主**。
3. **Claude Code 的实际接入示例**：贴出 `settings.json` 里 `Stop` hook 的配置。这是最大的搜索引擎入口，因为搜 "claude code stop hook" 的人就是目标用户。

## 5. 诚实的话

按目前 6 个竞品的下载量（30 天 25–316 次），这个品类**没有商业价值**。发它的价值是：一个 0 star 账号开始有可见的公开产出，并且 HN 上的一次讨论可能带来 3–5 个真实联系人——这比 star 数有用。

不要期待 Trending。把它当成"给自己建一个可被检索的身份"，而不是"上线一个产品"。
