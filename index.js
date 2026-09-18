/**
 * Anima PV Guard —— 0 侵入式补丁
 *
 * 问题：点开/刷新「提示词查看器」(JS-Slash-Runner) 时，它会故意发起一次真实生成
 *      Generate('normal') 来抓取最终提示词，直到 CHAT_COMPLETION_SETTINGS_READY
 *      才 abort。但酒馆在这之前就会跑扩展拦截器，Anima 的拦截器白名单里包含
 *      'normal'，于是这次伪造生成会真的跑一遍完整 RAG 检索：
 *      前端 /query -> 后端 getEmbedding() -> 真实调用向量模型 API（开重排还有重排模型），
 *      并顺带重写世界书里的注入条目。
 *
 * 做法：酒馆每次生成都是按 manifest 里的 generate_interceptor 名字去 globalThis
 *      动态查表调用，所以只要在 globalThis.Anima_RAG_Interceptor 外面包一层守卫就行。
 *      本文件不修改 Anima / JS-Slash-Runner 的任何代码，用属性陷阱安装，加载顺序无关。
 *
 * 判定：只有「用户真实参与」的回合才允许检索。真发送必然先产生 MESSAGE_SENT，
 *      群聊里每个成员开跑前会有 GROUP_MEMBER_DRAFTED；而查看器伪造的生成两者都没有。
 *
 * 记忆块回填：Anima 把检索结果写进聊天世界书的 [ANIMA_*_Container] 条目，并在每次
 *      生成结束时清空。跳过检索后查看器里就会缺少这一块，所以本补丁在每次真实回合
 *      结束后抄一份条目内容（快照），伪造生成时再写回去 —— 只回填记忆块，聊天正文
 *      仍由酒馆实时装配，因此不会"缺少最近一楼"。
 *
 * 热开关：因为拦截器是每次生成现查表调用的，所以「扩展设置面板里的开关」改的是本文件
 *      内部的一个变量，下一次生成立刻生效，不需要刷新页面（酒馆自带的扩展开关走
 *      enableExtension/disableExtension，那两个函数里有 location.reload()）。
 */

const GLOBAL_KEY = 'Anima_RAG_Interceptor';
const TAG = '[Anima PV Guard]';

/** 需要“用户回合”才放行的生成类型。提示词查看器用的是 'normal'。 */
const GATED_TYPES = ['normal'];

/**
 * Anima 拦截器白名单（interceptor.js 里的 allowedTypes）。
 * 只有这几种类型的生成，Anima 才可能真的跑检索并写容器；
 * 其它类型（regenerate / continue / quiet ...）它直接 early-return，
 * 此时容器是空的 —— 不能拿这个空状态去覆盖快照。
 */
const ANIMA_HANDLED_TYPES = ['chat', 'impersonate', 'swipe', 'normal'];

/** Anima 写入检索结果的两个世界书条目名 */
const SNAPSHOT_ENTRY_NAMES = [
  '[ANIMA_Chat_History_Container]',
  '[ANIMA_Knowledge_Container]',
];

/**
 * 还没有快照时（例如刚刷新过页面、这一局还没聊过）怎么办：
 *  true  = 放行一次真实检索，保证查看器里看到的是最新、完整的提示词（花一次向量调用）
 *  false = 照旧跳过，查看器里就没有记忆块（0 调用，但提示词不完整）
 */
const LIVE_FALLBACK_WHEN_NO_SNAPSHOT = true;

/**
 * 可选加强：伪造生成收尾时，Anima 的 generation_ended 处理器还会跑
 * clearRagEntry/clearKnowledgeEntry + 状态更新(generateText) + 总结检查。
 * 置为 true 会在 CHAT_COMPLETION_SETTINGS_READY 时刻先补发一次
 * generation_stopped，让那段逻辑走“生成被中断”的提前返回。
 * 代价：会向全局事件总线补发一个合成事件，属于进阶手段，默认关闭。
 */
const SUPPRESS_ANIMA_POST_GEN = false;

// ---------------------------------------------------------------- 运行时状态

/** 热开关：false = 完全放行（回到没装补丁的行为） */
let enabled = true;
/** 本次生成是否由用户真实参与（发消息 / 群聊成员轮次）触发 */
let userTurnArmed = false;
/** 刚被跳过的那次检索是否属于“伪造生成”，供可选的收尾抑制使用 */
let fakeTurnPending = false;

/** 上一次真实回合注入的记忆块：条目名 -> 内容（可能为空字符串，表示"那次请求本来就没有这块"） */
let snapshot = {};
/** 是否已经拿到过快照（决定伪造生成时是回填还是走 live 兜底） */
let hasSnapshot = false;
/** 本次伪造生成是否真的往世界书写了东西，供收尾清理用 */
let restoredThisTurn = false;
/** 给面板看的一句话状态 */
let lastAction = '尚未发生';

// ---------------------------------------------------------------- 世界书读写

function getTavernHelper() {
  const helper = globalThis.TavernHelper;
  return helper && typeof helper.getWorldbook === 'function' ? helper : null;
}

async function readEntries() {
  const helper = getTavernHelper();
  if (!helper) return null;
  const wbName = await helper.getChatWorldbookName('current');
  if (!wbName) return null;
  const entries = await helper.getWorldbook(wbName);
  if (!Array.isArray(entries)) return null;
  return { helper, wbName, entries };
}

async function writeEntries({ helper, wbName }, contents) {
  await helper.updateWorldbookWith(wbName, entries => {
    for (const entry of entries) {
      if (contents[entry.name] !== undefined) entry.content = contents[entry.name];
    }
    return entries;
  });
}

/** 真实回合结束后：把 Anima 刚写进去的记忆块抄一份 */
async function captureSnapshot() {
  try {
    const read = await readEntries();
    if (!read) return;
    const next = {};
    for (const name of SNAPSHOT_ENTRY_NAMES) {
      const entry = read.entries.find(e => e.name === name);
      next[name] = entry ? String(entry.content ?? '') : '';
    }
    snapshot = next;
    hasSnapshot = true;
  } catch (e) {
    console.warn(`${TAG} 记录记忆块快照失败（不影响生成）:`, e);
  }
}

/**
 * 伪造生成时：把上次注入的记忆块写回容器条目。
 * 只有条目当前是空的才写（避免覆盖更新的真实检索结果）。
 * @returns {Promise<boolean>} 是否已经拥有快照（没有快照则由调用方决定要不要放行）
 */
async function restoreSnapshot() {
  if (!hasSnapshot) return false;
  try {
    const read = await readEntries();
    if (!read) return true;

    const toWrite = {};
    let snapshotHadContent = false;
    let alreadyFresh = 0;

    for (const name of SNAPSHOT_ENTRY_NAMES) {
      const wanted = snapshot[name];
      if (!wanted) continue; // 上次请求本来就没有这一块
      snapshotHadContent = true;
      const entry = read.entries.find(e => e.name === name);
      if (!entry) continue;
      if (String(entry.content ?? '').trim() !== '') {
        alreadyFresh++; // 已有更新内容，别动
        continue;
      }
      toWrite[name] = wanted;
    }

    if (Object.keys(toWrite).length > 0) {
      await writeEntries(read, toWrite);
      restoredThisTurn = true;
      console.log(`${TAG} 已回填上次注入的记忆块: ${Object.keys(toWrite).join(' / ')}`);
    } else if (!snapshotHadContent) {
      console.log(`${TAG} 上次真实请求没有注入记忆块（检索结果为空 / RAG 未运行 / 未绑定库），无需回填`);
    } else if (alreadyFresh > 0) {
      console.log(`${TAG} 容器条目里已有更新的内容，无需回填`);
    } else {
      console.log(`${TAG} 世界书里没找到容器条目，无需回填`);
    }
  } catch (e) {
    console.warn(`${TAG} 回填记忆块失败（不影响生成）:`, e);
  }
  return true;
}

/**
 * 收尾：伪造生成结束后把回填的内容清掉（内容已被 Anima 清空时自动跳过），
 * 避免这份记忆块漏进之后不经拦截器的生成（如其他扩展的静默提示词）。
 */
async function cleanupRestored() {
  if (!restoredThisTurn) return;
  restoredThisTurn = false;
  try {
    const read = await readEntries();
    if (!read) return;
    const toClear = {};
    for (const name of SNAPSHOT_ENTRY_NAMES) {
      const entry = read.entries.find(e => e.name === name);
      if (entry && snapshot[name] && String(entry.content ?? '') === snapshot[name]) {
        toClear[name] = '';
      }
    }
    if (Object.keys(toClear).length > 0) await writeEntries(read, toClear);
  } catch (e) {
    /* 清理失败无所谓 */
  }
}

// ---------------------------------------------------------------- 拦截器守卫

function buildGuard(original) {
  if (typeof original !== 'function' || original.__pvGuarded) return original;

  const guarded = async function (chat, contextSize, abort, type) {
    const isFakeTurn = GATED_TYPES.includes(type) && !userTurnArmed;

    // 放行原拦截器：不是伪造生成 / 总开关被关掉
    if (!isFakeTurn || !enabled) {
      if (isFakeTurn && !enabled) {
        lastAction = '放行真实检索（功能已关闭）';
      }
      const result = await original.call(this, chat, contextSize, abort, type);
      if (!type || ANIMA_HANDLED_TYPES.includes(type)) await captureSnapshot();
      renderStatus();
      return result;
    }

    // 非用户回合（提示词查看器 / 插件伪造生成）
    const hadSnapshot = await restoreSnapshot();
    if (!hadSnapshot && LIVE_FALLBACK_WHEN_NO_SNAPSHOT) {
      console.log(`${TAG} 尚无记忆块快照，放行一次真实检索以保证提示词完整`);
      lastAction = '放行真实检索（无快照兜底）';
      const result = await original.call(this, chat, contextSize, abort, type);
      await captureSnapshot();
      renderStatus();
      return result;
    }

    fakeTurnPending = true;
    lastAction = restoredThisTurn ? '跳过检索 + 已回填记忆块' : '跳过检索（本次未回填）';
    console.log(
      `${TAG} 非用户回合（提示词查看器/插件伪造生成），跳过 RAG 检索` +
        (restoredThisTurn ? '（已回填记忆块）' : ''),
    );
    renderStatus();
    return; // 不调用原拦截器 = 不请求向量/重排模型
  };

  Object.defineProperty(guarded, '__pvGuarded', { value: true });
  Object.defineProperty(guarded, '__pvOriginal', { value: original });
  return guarded;
}

function installGlobalTrap() {
  let inner = buildGuard(globalThis[GLOBAL_KEY]);
  Object.defineProperty(globalThis, GLOBAL_KEY, {
    configurable: true,
    get: () => inner,
    set: fn => {
      inner = buildGuard(fn);
      console.log(`${TAG} 已包裹 Anima 拦截器`);
    },
  });
  console.log(`${TAG} 已接管 globalThis.${GLOBAL_KEY}`);
}

// ---------------------------------------------------------------- 设置面板

const PANEL_ID = 'anima-pv-guard-panel';

function panelHtml() {
  return `
<div class="inline-drawer" id="${PANEL_ID}">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>Anima PV Guard</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <label class="checkbox_label" for="anima-pv-guard-enabled" title="取消勾选即完全放行：点开/刷新提示词查看器会像没装补丁一样真的检索一次（会调用向量模型）">
      <input id="anima-pv-guard-enabled" type="checkbox" />
      <span>跳过提示词查看器的 RAG 检索（改完立刻生效，无需刷新）</span>
    </label>
    <small id="anima-pv-guard-status" class="anima-pv-guard-status" style="display:block;margin-top:6px;opacity:0.75;line-height:1.4;"></small>
  </div>
</div>`;
}

function shortEntryName(name) {
  return name.replace('[ANIMA_', '').replace('_Container]', '');
}

function renderStatus() {
  const el = globalThis.document?.getElementById('anima-pv-guard-status');
  if (!el) return;
  const snap = Object.entries(snapshot)
    .map(([k, v]) => `${shortEntryName(k)}: ${v ? `${v.length} 字` : '空'}`)
    .join(' / ');
  el.textContent =
    `${enabled ? '已启用（伪造生成跳过检索）' : '已关闭（放行检索）'}` +
    `｜上次: ${lastAction}` +
    `｜快照: ${hasSnapshot ? snap : '无'}`;
}

function persistSetting() {
  const ctx = globalThis.SillyTavern?.getContext?.();
  if (!ctx?.extensionSettings) return;
  if (!ctx.extensionSettings.anima_pv_guard) ctx.extensionSettings.anima_pv_guard = {};
  ctx.extensionSettings.anima_pv_guard.enabled = enabled;
  ctx.saveSettingsDebounced?.();
}

function toast(message, type = 'info') {
  const t = globalThis.toastr;
  if (!t) return;
  (t[type] ?? t.info)?.call(t, message, 'Anima PV Guard');
}

function setEnabled(value) {
  enabled = !!value;
  const box = globalThis.jQuery?.('#anima-pv-guard-enabled');
  box?.prop?.('checked', enabled);
  persistSetting();
  renderStatus();
  return enabled;
}

function initUi(attempt = 0) {
  const $ = globalThis.jQuery;
  const container = globalThis.document?.getElementById('extensions_settings2');
  if (typeof $ !== 'function' || !container) {
    if (attempt < 60) setTimeout(() => initUi(attempt + 1), 500);
    return;
  }
  if (globalThis.document.getElementById('anima-pv-guard-enabled')) return; // 已经渲染过

  const ctx = globalThis.SillyTavern?.getContext?.();
  enabled = ctx?.extensionSettings?.anima_pv_guard?.enabled ?? true;

  $(container).append(panelHtml());
  $('#anima-pv-guard-enabled').prop('checked', enabled).on('change', function () {
    setEnabled($(this).prop('checked'));
  });
  renderStatus();
}

// ---------------------------------------------------------------- 事件与启动

function installEventHooks(attempt = 0) {
  const es = globalThis.SillyTavern?.getContext?.()?.eventSource;
  if (!es) {
    if (attempt < 60) setTimeout(() => installEventHooks(attempt + 1), 500);
    else console.warn(`${TAG} 未拿到 eventSource，守卫未生效`);
    return;
  }

  es.on('message_sent', () => { userTurnArmed = true; });          // 用户真发消息
  es.on('group_member_drafted', () => { userTurnArmed = true; });  // 群聊第 2..N 个成员
  es.on('generation_ended', () => { userTurnArmed = false; void cleanupRestored(); renderStatus(); });
  es.on('generation_stopped', () => { userTurnArmed = false; void cleanupRestored(); renderStatus(); });
  es.on('chat_id_changed', () => {                                 // 换聊天：快照作废
    snapshot = {};
    hasSnapshot = false;
    restoredThisTurn = false;
    lastAction = '尚未发生';
    renderStatus();
  });

  if (SUPPRESS_ANIMA_POST_GEN) {
    es.on('chat_completion_settings_ready', () => {
      if (!fakeTurnPending) return;
      fakeTurnPending = false;
      es.emit('generation_stopped');
    });
  }

  console.log(`${TAG} 回合守卫已就绪`);
}

installGlobalTrap();
installEventHooks();
initUi();

// 控制台 / 脚本接口：AnimaPVGuard.status() · AnimaPVGuard.setEnabled(false)
globalThis.AnimaPVGuard = {
  status: () => ({
    hasInterceptor: typeof globalThis[GLOBAL_KEY] === 'function',
    wrapped: !!globalThis[GLOBAL_KEY]?.__pvGuarded,
    enabled,
    lastAction,
    userTurnArmed,
    hasSnapshot,
    restoredThisTurn,
    snapshotPreview: Object.fromEntries(
      Object.entries(snapshot).map(([k, v]) => [k, v ? `${v.length} 字` : '(空)']),
    ),
    gatedTypes: GATED_TYPES,
    liveFallback: LIVE_FALLBACK_WHEN_NO_SNAPSHOT,
    suppressPostGen: SUPPRESS_ANIMA_POST_GEN,
  }),
  setEnabled,
};
