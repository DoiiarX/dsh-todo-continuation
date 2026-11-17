/**
 * 宿主端最小测试：用假 ctx / 假 agent 验证按 step 计数与停止门禁。
 * 运行：node test.mjs
 */
import assert from 'node:assert/strict'
import { apply, Config } from './index.js'

function makeHarness() {
  const handlers = new Map()
  const steers = []
  const ctx = {
    root: { logger: () => ({ error() {}, info() {} }) },
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
    },
    inject(names, fn) {
      if (typeof fn === 'function') fn(ctx)
    },
    effect() {},
    settings: { configure() {} },
    fiber: {},
  }

  const session = { id: 's1', events: [] }
  const agent = {
    session,
    steer(message) { steers.push(message) },
  }

  const emit = async (name, payload) => {
    for (const fn of handlers.get(name) ?? []) await fn(payload)
  }

  /** 追加一个 turn：steps 个 step，可选 todo 快照。 */
  const addTurn = (turn, steps, todos) => {
    session.events.push({ type: 'turn/start', data: { turn } })
    for (let i = 0; i < steps; i += 1) session.events.push({ type: 'step/start', data: { turn, step: i + 1 } })
    if (todos !== undefined) session.events.push({ type: 'todo/write', data: { todos } })
    return turn
  }

  const stopTurn = (turn) => emit('agent/turn-stopping', { agent, turn, signal: { throwIfAborted() {} } })

  return { ctx, agent, session, steers, addTurn, stopTurn, emit }
}

const TODO_DONE = [{ content: '做完 A', status: 'completed' }]
const TODO_OPEN = [{ content: '继续 B', status: 'in_progress' }]

async function main() {
  // 1) 配置默认值按 step 计
  assert.equal(Config.dict['noTodoPromptEveryNSteps'].meta.default, 64, '默认无 Todo 间隔应是 64 步')
  assert.equal(Config.dict['staleTodoPromptEveryNSteps'].meta.default, 256, '默认过期间隔应是 256 步')

  // 2) 无 Todo：累计步数跨过阈值才提示一次，且提示文案说 steps
  {
    const h = makeHarness()
    await apply(h.ctx, { noTodoPromptEveryNSteps: 10, staleTodoPromptEveryNSteps: 100 })
    h.addTurn(1, 4)
    await h.stopTurn(1)
    assert.equal(h.steers.length, 0, '4 步不该提示')
    h.addTurn(2, 5)
    await h.stopTurn(2)
    assert.equal(h.steers.length, 0, '累计 9 步仍不该提示')
    h.addTurn(3, 6)
    await h.stopTurn(3)
    assert.equal(h.steers.length, 1, '累计 15 步应提示一次')
    const text = h.steers[0].content[0].text
    assert.match(text, /for the last 10 steps/, '文案应说明是 step')
    assert.equal(h.steers[0].source.kind, 'plugin:todo-continuation')

    // 提示后清零：再来 9 步不提示
    h.addTurn(4, 9)
    await h.stopTurn(4)
    assert.equal(h.steers.length, 1, '提示后计数应清零')
    h.addTurn(5, 2)
    await h.stopTurn(5)
    assert.equal(h.steers.length, 2, '再累计跨过 10 步应再次提示')
  }

  // 3) 门禁：本轮有未完成 todo 就 steer 继续；全部完成则放行
  {
    const h = makeHarness()
    await apply(h.ctx, {})
    h.addTurn(1, 3, TODO_OPEN)
    await h.stopTurn(1)
    assert.equal(h.steers.length, 1, '未完成 todo 应拦停')
    assert.match(h.steers[0].content[0].text, /cannot stop/)

    h.addTurn(2, 3, TODO_DONE)
    await h.stopTurn(2)
    assert.equal(h.steers.length, 1, '全部完成应放行')

    h.addTurn(3, 3, [{ content: '信息不足：需要用户确认', status: 'pending' }])
    await h.stopTurn(3)
    assert.equal(h.steers.length, 1, '等待前缀的 todo 应放行')
  }

  // 4) 过期提示：写了 todo 之后连续很多步不更新
  {
    const h = makeHarness()
    await apply(h.ctx, { staleTodoPromptEveryNSteps: 12 })
    h.addTurn(1, 2, TODO_OPEN)
    await h.stopTurn(1) // 门禁会拦，但计数同时清零
    const before = h.steers.length
    h.addTurn(2, 6)
    await h.stopTurn(2)
    assert.equal(h.steers.length, before, '6 步不到 12 步阈值')
    h.addTurn(3, 7)
    await h.stopTurn(3)
    assert.equal(h.steers.length, before + 1, '累计 13 步应触发过期提示')
    assert.match(h.steers.at(-1).content[0].text, /has not been updated for the last 12 steps/)
  }

  // 5) 同一轮重复触发 turn-stopping 只计一次
  {
    const h = makeHarness()
    await apply(h.ctx, { noTodoPromptEveryNSteps: 5 })
    h.addTurn(1, 6)
    await h.stopTurn(1)
    await h.stopTurn(1)
    assert.equal(h.steers.length, 1, '同一轮不应重复计数')
  }

  console.log('todo-continuation: all step-count assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
