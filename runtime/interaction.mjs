export const name = 'dshc-interaction'
export const inject = ['tools']
export async function apply(ctx) {
  const url = process.env.DSHC_INTERACTION_URL
  const token = process.env.DSHC_INTERACTION_TOKEN
  const runtimeId = process.env.DSHC_INTERACTION_ID
  if (!url || !token || !runtimeId) return
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  // A human answer may take longer than fetch's implicit response-header timeout.
  const post = (path, body, signal) => new Promise((resolve, reject) => {
    const req = httpRequest(`${url}${path}`, { method: 'POST', headers, signal }, res => {
      res.setEncoding('utf8')
      let data = ''; let size = 0
      res.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 96 * 1024) res.destroy(new Error('Interaction response too large')); else data += chunk })
      res.on('error', reject)
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error(`Interaction unavailable (${res.statusCode}); only the active main agent may ask`); resolve(JSON.parse(data)) } catch (error) { reject(error) } })
    })
    req.on('error', reject); req.end(JSON.stringify(body))
  })
  await post('/ready', { runtimeId }, AbortSignal.timeout(5000))
  const question = { type: 'object', additionalProperties: false, required: ['id', 'title', 'options'], properties: {
    id: { type: 'string' }, title: { type: 'string' }, options: { type: 'array', minItems: 2, maxItems: 5, items: {
      type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' }, description: { type: 'string' }, recommended: { type: 'boolean' } },
    } },
  } }
  const definitions = [{ name: 'request_user_input', description: 'Ask the user 1–3 clarification questions with options and optional free text. Only the main agent may ask; subagents report questions to the main agent. This waits for an explicit answer and does not grant tool permissions.',
    parameters: { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', minItems: 1, maxItems: 3, items: question } } }, kind: 'questions' }]
  if (process.env.DSHC_WORK_MODE === 'plan') definitions.push({ name: 'present_plan', description: 'Present a complete plan for review. The user may revise, defer, or explicitly choose implementation. Remain read-only and end your turn after implementation is selected; the terminal performs the mode handoff.',
    parameters: { type: 'object', additionalProperties: false, required: ['title', 'text'], properties: { title: { type: 'string' }, text: { type: 'string' } } }, kind: 'plan' })
  // Declared up front and never waited on: the terminal shows it beside the
  // work while the work happens. A blocking call here would turn "say what you
  // are about to do" into "stop and ask", which is a different feature.
  if (process.env.DSHC_WORK_MODE !== 'plan') ctx.effect(() => ctx.tools.register({
    name: 'outline_plan',
    description: 'State the steps you are about to take, before taking them. Call once at the start of a task that will take more than one step. Two to six short steps, each a few words. Returns immediately; it does not ask the user anything.',
    parameters: { type: 'object', additionalProperties: false, required: ['steps'], properties: {
      steps: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'Plan shown to the user.' }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('outline_plan requires a root agent')
      await post('/plan', { runtimeId, steps: args.steps }, exec.signal)
      return { ok: true }
    },
  }))

  for (const { kind, ...definition } of definitions) ctx.effect(() => ctx.tools.register({ ...definition,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('Interaction requires a root agent')
      return await post('/request', { runtimeId, sessionId: exec.agent.session.id, callId: exec.callId, content: { ...args, kind } }, exec.signal)
    },
  }))
}
import { request as httpRequest } from 'node:http'
