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
 */

const GLOBAL_KEY = 'Anima_RAG_Interceptor';
const TAG = '[Anima PV Guard]';

/** 需要“用户回合”才放行的生成类型。提示词查看器用的是 'normal'。 */
const GATED_TYPES = ['normal'];

/**
 * 可选加强：伪造生成收尾时，Anima 的 generation_ended 处理器还会跑
 * clearRagEntry/clearKnowledgeEntry + 状态更新(generateText) + 总结检查。
 * 置为 true 会在 CHAT_COMPLETION_SETTINGS_READY 时刻先补发一次
 * generation_stopped，让那段逻辑走“生成被中断”的提前返回。
 * 代价：会向全局事件总线补发一个合成事件，属于进阶手段，默认关闭。
 */
const SUPPRESS_ANIMA_POST_GEN = false;

/** 本次生成是否由用户真实参与（发消息 / 群聊成员轮次）触发 */
let userTurnArmed = false;
/** 刚被跳过的那次检索是否属于“伪造生成”，供可选的收尾抑制使用 */
let fakeTurnPending = false;

function buildGuard(original) {
  if (typeof original !== 'function' || original.__pvGuarded) return original;

  const guarded = async function (chat, contextSize, abort, type) {
    if (GATED_TYPES.includes(type) && !userTurnArmed) {
      fakeTurnPending = true;
      console.log(`${TAG} 非用户回合（提示词查看器/插件伪造生成），跳过 RAG 检索`);
      return; // 不调用原拦截器 = 不请求向量/重排模型，也不写世界书
    }
    return original.call(this, chat, contextSize, abort, type);
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

function installEventHooks(attempt = 0) {
  const es = globalThis.SillyTavern?.getContext?.()?.eventSource;
  if (!es) {
    if (attempt < 60) setTimeout(() => installEventHooks(attempt + 1), 500);
    else console.warn(`${TAG} 未拿到 eventSource，守卫未生效`);
    return;
  }

  es.on('message_sent', () => { userTurnArmed = true; });          // 用户真发消息
  es.on('group_member_drafted', () => { userTurnArmed = true; });  // 群聊第 2..N 个成员
  es.on('generation_ended', () => { userTurnArmed = false; });
  es.on('generation_stopped', () => { userTurnArmed = false; });

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

// 调试用：window.AnimaPVGuard.status()
globalThis.AnimaPVGuard = {
  status: () => ({
    hasInterceptor: typeof globalThis[GLOBAL_KEY] === 'function',
    wrapped: !!globalThis[GLOBAL_KEY]?.__pvGuarded,
    userTurnArmed,
    gatedTypes: GATED_TYPES,
    suppressPostGen: SUPPRESS_ANIMA_POST_GEN,
  }),
};
