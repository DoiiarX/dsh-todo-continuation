/**
 * @doiiarx/dsh-todo-continuation —— Todo 停止门禁 + 提示插件（host 级）。
 *
 * 双面包（与 @doiiarx/dsh-user-language 同一套工作模式）：
 *   - 宿主端（本文件）：注册 `todo-continuation` settings 命名空间
 *     （`waitingTodoPrefixes` / `noTodoPromptEveryNTurns` /
 *     `staleTodoPromptEveryNTurns`），监听 `agent/turn-stopping`，实现：
 *       1) 门禁：当前 turn 有未完成且非「等待用户」的 todo 时继续推进；
 *       2) 无 Todo 提示：连续 N 个 step 没有任何 todo 快照时提示模型开始用 todo；
 *       3) 过期 Todo 提示：已有 todo 却连续 M 个 step 不更新时提示模型保持最新。
 *
 * step = 一次模型调用（一次请求/一次回复）。同一次回复里并行发出多个工具调用仍算
 * 一个 step；轮次（turn）是更粗的单位，一轮通常包含十几个 step。
 *     三个阈值都从 settings 实时读取，用户在设置页改动后下一轮立即生效。
 *   - 浏览器端（client.js）：在设置页渲染「Todo 门禁」小节，编辑三个字段。
 *
 * 失败隔离（与 user-language 相同）：本文件保持零外部依赖，schemastery 在
 * apply() 里动态 import，任何失败降级为诊断日志，不会拖垮整个 profile。
 */

import z from '@deepseek-ai/schemastery'

export const name = 'todo-continuation-supervisor'
export const inject = ['settings']

const PLUGIN_SOURCE = { kind: 'plugin:todo-continuation' }
const DEFAULT_WAITING_PREFIXES = ['信息不足：', '要求用户确认：']
// 计数单位是 step（一次模型调用）。本机实测一轮约 16 个 step，
// 所以 64 步≈4 轮、256 步≈16 轮，与旧版 5 轮/20 轮的手感接近。
const DEFAULT_NO_TODO_EVERY_STEPS = 64
const DEFAULT_STALE_EVERY_STEPS = 256

/**
 * 插件配置，同时就是设置页中的 section：0.2 起 settings 段由 entry 的配置派生
 * （不再是插件注册 namespace + schema）。改动写入 profile 后 Loader 重新解析并
 * reload 本插件，因此 apply 拿到的 config 始终是最新值。
 */
export const Config = z.object({
  // volatile 是设置页读写这些字段的前提（settings 只暴露 volatile 字段）。
  waitingTodoPrefixes: z.array(z.string()).default([...DEFAULT_WAITING_PREFIXES]).extra('volatile', true),
  noTodoPromptEveryNSteps: z.number().default(DEFAULT_NO_TODO_EVERY_STEPS).extra('volatile', true),
  staleTodoPromptEveryNSteps: z.number().default(DEFAULT_STALE_EVERY_STEPS).extra('volatile', true),
})

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

/** 统计某个 turn 内跑了多少个 step（step/start 事件数）；用来把轮次换成步数。 */
function stepsInTurn(session, turn) {
  let insideTurn = false
  let steps = 0
  for (const event of session.events ?? []) {
    if (event.type === 'turn/start') {
      insideTurn = event.data?.turn === turn
      continue
    }
    if (insideTurn && event.type === 'step/start') steps += 1
  }
  return steps
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

function noTodoPromptMessage(everyNSteps) {
  return `No todo list has been created for the last ${everyNSteps} steps. `
    + 'For work that spans multiple steps or continues across turns, use the `todo_write` tool to plan and track it: '
    + 'create actionable todos, update their status as you finish, and complete the list before the work is done. '
    + 'A trivial single-step answer does not need a todo list.'
}

function staleTodoPromptMessage(everyNSteps) {
  return `The todo list has not been updated for the last ${everyNSteps} steps. `
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

/** 读取并归一化插件配置里的三个值（0.2：配置即 settings section）。 */
function readConfig(value = {}) {
  const prefixes = Array.isArray(value.waitingTodoPrefixes) && value.waitingTodoPrefixes.length > 0
    ? value.waitingTodoPrefixes.map(prefix => String(prefix))
    : [...DEFAULT_WAITING_PREFIXES]
  const noTodoEverySteps = Number.isSafeInteger(value.noTodoPromptEveryNSteps) && value.noTodoPromptEveryNSteps >= 1
    ? value.noTodoPromptEveryNSteps
    : DEFAULT_NO_TODO_EVERY_STEPS
  const staleEverySteps = Number.isSafeInteger(value.staleTodoPromptEveryNSteps) && value.staleTodoPromptEveryNSteps >= 1
    ? value.staleTodoPromptEveryNSteps
    : DEFAULT_STALE_EVERY_STEPS
  return { prefixes, noTodoEverySteps, staleEverySteps }
}

export async function apply(ctx, config = {}) {
  console.log('[todo-continuation] apply() invoked (config-driven settings, 0.2)')
  // 1) settings 策略：本插件自带设置页（client.js），故关闭自动生成的表单。
  try {
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  } catch (error) {
    report(ctx, 'settings-policy', error)
  }

  // 2) 每个 session 的提示状态（turn 去重 + 两条独立计数 + 各自冷却）。
  const states = new Map()

  ctx.on('session/disposed', (session) => {
    states.delete(session.id)
  }, { global: true })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    signal.throwIfAborted()
    const cfg = readConfig(config)
    const todos = currentTurnTodos(agent.session, turn)
    if (todos !== undefined) {
      // 本轮写了 todo：结束两条计数，记录最近一次写入轮。
      const state = states.get(agent.session.id) ?? emptyState()
      state.noTodoSteps = 0
      state.staleSteps = 0
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
    const steps = stepsInTurn(agent.session, turn)
    if (state.lastTodoWriteTurn === 0) {
      // 还没有列表：累计「无 Todo」步数。
      state.noTodoSteps += steps
      if (state.noTodoSteps >= cfg.noTodoEverySteps) {
        agent.steer(steerMessage(noTodoPromptMessage(cfg.noTodoEverySteps)))
        state.noTodoSteps = 0
      }
    } else {
      // 已有列表但本轮没写：累计「过期」步数。
      state.staleSteps += steps
      if (state.staleSteps >= cfg.staleEverySteps) {
        agent.steer(steerMessage(staleTodoPromptMessage(cfg.staleEverySteps)))
        state.staleSteps = 0
      }
    }
    states.set(agent.session.id, state)
  })

  return undefined
}

function emptyState() {
  return {
    noTodoSteps: 0,
    staleSteps: 0,
    lastTodoWriteTurn: 0,
    lastCountedTurn: 0,
  }
}
