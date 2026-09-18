# Anima PV Guard（Anima 提示词查看器补丁）

```
说明:
本插件为 Anima 系列插件 (anima-rag / Anima-Memory-System) 的配套二创补丁
不修改原插件的任何文件, 装上即生效, 删掉即还原
禁止商业化行为
```

原作者: Ellinav

原仓库地址: [anima-rag 后端](https://github.com/Ellinav/anima-rag) · [Anima-Memory-System 前端](https://github.com/Ellinav/Anima-Memory-System)

---

## 解决什么问题

点开/刷新酒馆的「提示词查看器」时，**会真的触发一次 RAG 检索**——后端 `/query` → 调用一次**向量模型 API**（开了重排还会再调一次重排模型），并且重写一遍世界书里的注入条目。

原因是「提示词查看器」靠伪造一次真实生成来抓取提示词：它调用 `Generate('normal')`，直到 `CHAT_COMPLETION_SETTINGS_READY` 才 abort。而酒馆在这之前就会跑扩展拦截器，Anima 的拦截器白名单里包含 `normal`，于是这次伪造生成被当成真实回合，整套检索白跑一遍（聊天补全本身倒是被 abort 掉了，不花聊天模型的钱）。

本补丁只放行"用户真实参与"的回合：拦截器在 `type === 'normal'` 且**没有** `message_sent` / `group_member_drafted` 时直接返回，于是提示词查看器的伪造生成不再触发检索。

## 安装

1. 先按原作者的说明正常安装 **anima-rag**（后端）与 **Anima-Memory-System**（前端）两个插件。
2. 酒馆 → 扩展 → 安装扩展 → 粘贴本仓库地址：

   ```
   https://github.com/JulyXP3/Anima-PV-Guard
   ```

3. F5 刷新页面（新扩展目录无需重启 Node 服务）。

装好后扩展列表里会多出一项 **Anima PV Guard**，默认启用；关掉它就等于没装。

## 原理

酒馆每次生成都按 manifest 里的 `generate_interceptor` 名字去 `globalThis` 动态查表调用拦截器（`public/scripts/extensions.js:1743-1746`），所以本插件用属性陷阱包住 `globalThis.Anima_RAG_Interceptor`，不改动 Anima 一行代码，也不受两者加载顺序影响。

## 测试方法

### 两个控制台，日志分开放

| 位置 | 关键日志 |
| --- | --- |
| **浏览器 F12 → Console** | `[Anima PV Guard] …`、`[Anima Debug] Interceptor Called! Type: X`、`[Anima] 🚀 发起双轨检索...` |
| **后端 Node 终端**（启动酒馆的窗口 / `docker logs -f`） | `[Anima Debug] Embedding Request -> URL: …`（**真的调了向量模型的铁证**）、`[Anima Rerank] 📡 发起重排请求 …` |

⚠️ 前缀两边会重名：`[Anima Debug]`、`[Anima RAG]` 前后端都在用。最容易搞混的一对是 `[Anima Debug] Interceptor Called!`（浏览器）和 `[Anima Debug] Embedding Request`（后端）—— 认消息原文，别认前缀。

### 1. 自检

F5 刷新，F12 → Console 勾上 **Preserve log**，过滤框输入 `Anima`，应看到：

```
[Anima PV Guard] 已接管 globalThis.Anima_RAG_Interceptor
[Anima PV Guard] 已包裹 Anima 拦截器        <- 可能晚几秒, Anima 要等 TavernHelper 就绪
[Anima PV Guard] 回合守卫已就绪
```

再执行 `AnimaPVGuard.status()`，`wrapped: true` 是硬指标。

### 2. 基线：正常聊天不受影响（不能省）

正常发一条消息。浏览器应出现 `[Anima Debug] Interceptor Called! Type: normal` → `[Anima] 🚀 发起双轨检索...`，后端应出现 `[Anima Debug] Embedding Request`。

### 3. 核心用例：提示词查看器

> ⚠️ 先清空输入框。若框里有草稿，查看器伪造的那次生成会把草稿当真实消息发出去（查看器自身行为），既冒出幽灵消息，也会产生 `message_sent` 使补丁按设计放行检索。

点「提示词查看器」及右上角刷新图标，期望：浏览器出现 `[Anima PV Guard] 非用户回合（提示词查看器/插件伪造生成），跳过 RAG 检索（已回填记忆块）`，且**没有** `Interceptor Called!`，后端**没有**新的 `Embedding Request`；查看器的提示词列表照常显示，**记忆块（记忆召回 / 前情提要）也在**。

### 4. 反向对照

扩展面板里关掉本插件 → F5 → 再点查看器，`Interceptor Called!` 与 `Embedding Request` 应重新出现。

### 5. 回归清单

- swipe/划回：仍照常检索（`swipe` 在原白名单里）
- 「重新生成」：会打印 `Called! Type: regenerate` 后立刻被跳过 —— 这是 Anima 既有行为（白名单不含 `regenerate`），不是本补丁造成的
- 连续发两条：第二条也要检索
- 群聊：第 1、第 2 个成员都要检索

## 记忆块回填（查看器里为什么还能看到记忆 / 前情提要）

Anima 是把检索结果写进**聊天世界书**的 `[ANIMA_Chat_History_Container]`（记忆召回、前情提要）与 `[ANIMA_Knowledge_Container]`（知识库）两个条目里来注入的，并且**每次生成结束都会把这两个条目清空**，等下一次真实生成时再重新填入。

跳过检索后，伪造生成的那次就不会再填了，查看器里就会缺掉这一块。所以本补丁做了一件事：

- **真实回合结束后**，把这两个条目当时的内容抄一份存进内存（快照）。
- **伪造生成时**，先判断条目是不是空的；是空的就把快照写回去，再由酒馆照常装配提示词。只在条目为空时才写，所以绝不会覆盖更新的真实检索结果。

因此**聊天正文是实时的**（包括最近一楼），只有记忆块来自快照 —— 它展示的是「上一次真实请求实际注入的那份」，也就是模型真正看到过的内容（比重新检索更贴近事实）。若想改成"按当前聊天重算"，把 `LIVE_FALLBACK_WHEN_NO_SNAPSHOT` 关掉也不会变成重算，那只会让它变成空；真要重算就是不跳过检索。

伪造生成结束后，回填的内容会被清理掉（内容与快照一致时才清），避免这份记忆漏进之后不经拦截器的生成（比如其他扩展的静默提示词）。

## 两个开关

都在 `index.js` 顶部：

| 常量 | 默认 | 作用 |
| --- | --- | --- |
| `LIVE_FALLBACK_WHEN_NO_SNAPSHOT` | `true` | 还没有快照时（刚刷新过页面、这一局还没聊过）放行一次真实检索，保证查看器里看到完整提示词（花一次向量调用）。设为 `false` 则一律跳过，此时查看器里没有记忆块 |
| `SUPPRESS_ANIMA_POST_GEN` | `false` | 改为 `true` 后，会在 `CHAT_COMPLETION_SETTINGS_READY` 时刻对伪造生成补发一次 `generation_stopped`，使 Anima 的生成收尾流程（清空注入条目 / 状态更新 / 总结检查）走"生成被中断"的提前返回。代价是向全局事件总线补发合成事件 |

## 预期变化（不是故障）

1. 打开查看器时 Anima 的 `generation_started` 仍会跑（状态倒计时被取消等），这是它自己的监听器，本补丁不碰。
2. 换聊天后第一处打开查看器：快照已作废，若 `LIVE_FALLBACK_WHEN_NO_SNAPSHOT` 为真会真检索一次（日志会写「尚无记忆块快照，放行一次真实检索」）。
3. 调试信息：控制台执行 `AnimaPVGuard.status()` 可以看到 `hasSnapshot` / `snapshotPreview`（各条目回填了多少字）。

## 排错

| 现象 | 原因 |
| --- | --- |
| 只有"已接管"，没有"已包裹" | Anima 的 `initInterceptor()` 还没跑（它在等 TavernHelper）；等几秒，长期不出现就检查 Anima 是否启用 |
| 改了 `index.js` 不生效 | 浏览器缓存；Ctrl+F5 硬刷新 |
| 点查看器没日志也没检索 | 可能 RAG 总开关本来就关着，或当前没绑定任何库（本来也不会检索） |
| 找不到 `Embedding Request` | 它只在后端终端；Docker 里跑的酒馆用 `docker logs -f <容器名>` |
