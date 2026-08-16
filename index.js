/**
 * @doiiarx/dsh-todo-continuation —— Todo 停止门禁 + 提示插件（host 级）。
 *
 * 双面包（与 @doiiarx/dsh-user-language 同一套工作模式）：
 *   - 宿主端（本文件）：注册 `todo-continuation` settings 命名空间
 *     （`waitingTodoPrefixes` / `noTodoPromptEveryNTurns` /
 *     `staleTodoPromptEveryNTurns`），监听 `agent/turn-stopping`，实现：
 *       1) 门禁：当前 turn 有未完成且非「等待用户」的 todo 时继续推进；
 *       2) 无 Todo 提示：连续 N 轮没有任何 todo 快照时提示模型开始用 todo；
 *       3) 过期 Todo 提示：已有 todo 却连续 M 轮不更新时提示模型保持最新。
 *     三个阈值都从 settings 实时读取，用户在设置页改动后下一轮立即生效。
 *   - 浏览器端（client.js）：在设置页渲染「Todo 门禁」小节，编辑三个字段。
 *
 * 失败隔离（与 user-language 相同）：本文件保持零外部依赖，schemastery 在
 * apply() 里动态 import，任何失败降级为诊断日志，不会拖垮整个 profile。
 */

export const name = 'todo-continuation-supervisor'
export const inject = ['settings']

const SETTINGS_NS = 'todo-continuation'
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'todo-continuation' }
const DEFAULT_WAITING_PREFIXES = ['信息不足：', '要求用户确认：']
const DEFAULT_NO_TODO_EVERY = 5
const DEFAULT_STALE_EVERY = 20

function report(ctx, scope, error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const message = `[todo-continuation] ${scope} unavailable: ${detail}`
  const logger = ctx.root?.logger?.('todo-continuation')
  if (logger?.error) logger.error('%s', message)
  console.error(message)
}

/** 读取某个 turn 内最新的 todo 快照；该 turn 内没有 todo/write 时返回 undefined。 */
function currentTurnTodos(session, turn) {
  let insideTurn = false
  let latest
  for (const event of session.events ?? []) {
    if (event.type === 'turn/start') {
      insideTurn = event.data?.turn === turn
      if (insideTurn) latest = undefined
      continue
    }
    if (insideTurn && event.type === 'todo/write') latest = event.data?.todos
  }
  return latest
}

function isWaitingTodo(todo, prefixes) {
  return prefixes.some(prefix => todo.content?.startsWith(prefix))
}

function continuationMessage(prefixes) {
  const markers = prefixes.map(prefix => JSON.stringify(`${prefix}...`)).join(', ')
  return 'The current todo list still contains unfinished work, so this turn cannot stop. '
    + 'Continue executing the remaining actionable todos now; do not only summarize progress or describe future work. '
    + 'Update the complete todo list with `todo_write` as work finishes. '
    + `A stop is allowed only after every todo is completed, or when every remaining unfinished todo starts with one of these user-wait markers: ${markers}. `
    + 'Do not use a waiting todo for work you can complete with the available context and tools.'
}

function noTodoPromptMessage(everyNTurns) {
  return `No todo list has been created for the last ${everyNTurns} turns. `
    + 'For work that spans multiple steps or continues across turns, use the `todo_write` tool to plan and track it: '
    + 'create actionable todos, update their status as you finish, and complete the list before the work is done. '
    + 'A trivial single-step answer does not need a todo list.'
}

function staleTodoPromptMessage(everyNTurns) {
  return `The todo list has not been updated for the last ${everyNTurns} turns. `
    + 'Keep the `todo_write` list current as the work progresses: update statuses, add new actionable todos, '
    + 'and complete finished items. A stale list does not reflect the remaining work.'
}

/** 构造一个标识过的 user message（不依赖 @deepseek-ai/dsh-llm）。 */
function steerMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: PLUGIN_SOURCE,
  }
}

/** 读取并归一化 settings 里的三个配置值。 */
function readConfig(scope) {
  const value = scope?.get?.() ?? {}
  const prefixes = Array.isArray(value.waitingTodoPrefixes) && value.waitingTodoPrefixes.length > 0
    ? value.waitingTodoPrefixes.map(prefix => String(prefix))
    : [...DEFAULT_WAITING_PREFIXES]
  const noTodoEvery = Number.isSafeInteger(value.noTodoPromptEveryNTurns) && value.noTodoPromptEveryNTurns >= 1
    ? value.noTodoPromptEveryNTurns
    : DEFAULT_NO_TODO_EVERY
  const staleEvery = Number.isSafeInteger(value.staleTodoPromptEveryNTurns) && value.staleTodoPromptEveryNTurns >= 1
    ? value.staleTodoPromptEveryNTurns
    : DEFAULT_STALE_EVERY
  return { prefixes, noTodoEvery, staleEvery }
}

export async function apply(ctx, config = {}) {
  console.log('[todo-continuation] apply() invoked, inject settings =', ctx.get('settings') !== undefined)
  // 1) 注册可持久化的 settings 命名空间（用户在设置页编辑它）。
  let scope
  try {
    const { default: Schema } = await import('schemastery')
    const base = {
      waitingTodoPrefixes: config.waitingTodoPrefixes ?? DEFAULT_WAITING_PREFIXES,
      noTodoPromptEveryNTurns: config.noTodoPromptEveryNTurns ?? DEFAULT_NO_TODO_EVERY,
      staleTodoPromptEveryNTurns: config.staleTodoPromptEveryNTurns ?? DEFAULT_STALE_EVERY,
    }
    scope = ctx.settings.register(SETTINGS_NS, Schema.object({
      waitingTodoPrefixes: Schema.array(Schema.string()).default(base.waitingTodoPrefixes),
      noTodoPromptEveryNTurns: Schema.number().default(base.noTodoPromptEveryNTurns),
      staleTodoPromptEveryNTurns: Schema.number().default(base.staleTodoPromptEveryNTurns),
    }), { base })
    console.log('[todo-continuation] settings namespace registered OK, scope =', scope !== undefined)
  } catch (error) {
    report(ctx, 'settings', error)
    scope = null
  }

  // 2) 每个 session 的提示状态（turn 去重 + 两条独立计数 + 各自冷却）。
  const states = new Map()

  ctx.on('session/disposed', (session) => {
    states.delete(session.id)
  }, { global: true })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    signal.throwIfAborted()
    const cfg = readConfig(scope)
    const todos = currentTurnTodos(agent.session, turn)
    if (todos !== undefined) {
      // 本轮写了 todo：结束两条计数，记录最近一次写入轮。
      const state = states.get(agent.session.id) ?? emptyState()
      state.noTodoCount = 0
      state.staleCount = 0
      state.lastTodoWriteTurn = turn
      states.set(agent.session.id, state)
      const unfinished = todos.filter(todo => todo.status !== 'completed')
      if (unfinished.length === 0 || unfinished.every(todo => isWaitingTodo(todo, cfg.prefixes))) return
      agent.steer(steerMessage(continuationMessage(cfg.prefixes)))
      return
    }
    const state = states.get(agent.session.id) ?? emptyState()
    if (state.lastCountedTurn === turn) return
    state.lastCountedTurn = turn
    if (state.lastTodoWriteTurn === 0) {
      // 还没有列表：累计「无 Todo」轮数。
      state.noTodoCount += 1
      if (state.noTodoCount >= cfg.noTodoEvery
        && (state.lastNoTodoPromptTurn === 0 || turn - state.lastNoTodoPromptTurn > cfg.noTodoEvery)) {
        agent.steer(steerMessage(noTodoPromptMessage(cfg.noTodoEvery)))
        state.lastNoTodoPromptTurn = turn
        state.noTodoCount = 0
      }
    } else {
      // 已有列表但本轮没写：累计「过期」轮数。
      state.staleCount += 1
      if (state.staleCount >= cfg.staleEvery
        && (state.lastStalePromptTurn === 0 || turn - state.lastStalePromptTurn > cfg.staleEvery)) {
        agent.steer(steerMessage(staleTodoPromptMessage(cfg.staleEvery)))
        state.lastStalePromptTurn = turn
        state.staleCount = 0
      }
    }
    states.set(agent.session.id, state)
  })

  return undefined
}

function emptyState() {
  return {
    noTodoCount: 0,
    staleCount: 0,
    lastTodoWriteTurn: 0,
    lastCountedTurn: 0,
    lastNoTodoPromptTurn: 0,
    lastStalePromptTurn: 0,
  }
}
