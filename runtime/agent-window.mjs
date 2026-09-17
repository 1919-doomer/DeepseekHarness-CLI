import { get } from 'node:http'
import { once } from 'node:events'
import { AgentWindowFormatter, safe } from './agent-window-format.mjs'
const zh = process.env.DSHC_AGENT_LOCALE === 'zh-CN'
const url = new URL(process.env.DSHC_AGENT_URL)
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Invalid local window endpoint')
const token = process.env.DSHC_AGENT_TOKEN
delete process.env.DSHC_AGENT_TOKEN
const formatter = new AgentWindowFormatter({ zh,
  columns: process.env.INK_SCREEN_READER === 'true' ? () => 0 : undefined,
  color: process.env.INK_SCREEN_READER !== 'true' && (process.env.DSHC_AGENT_COLOR === '1'
    || Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'),
  ascii: process.env.TERM === 'dumb' || process.env.DSHC_ASCII === '1',
})
async function write(text) { if (!process.stdout.write(text)) await once(process.stdout, 'drain') }
function poll(after) {
  return new Promise((resolve, reject) => {
    const target = new URL(url); target.searchParams.set('after', String(after))
    const req = get(target, { headers: { authorization: `Bearer ${token}` }, timeout: 5000 }, res => {
      let body = ''; res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(new Error('Window response too large')) })
      res.on('error', reject)
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('Window owner unavailable'); resolve(JSON.parse(body)) } catch (error) { reject(error) } })
    })
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Window connection timed out')))
  })
}
let after = 0, ended = false, title = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', () => { if (ended) process.exit(0) })
while (true) {
  try {
    const result = await poll(after)
    if (result.title !== title) {
      title = safe(result.title).slice(0, 200)
      process.title = `dshc · ${title}`
      await write(formatter.header(title))
    }
    if (result.truncated) await write(zh ? '\n[旧输出已裁剪，完整记录见主窗口 /trace 或历史]\n' : '\n[Older output trimmed; inspect /trace or history in the owner]\n')
    for (const entry of result.entries) { await write(formatter.entry(entry)); after = entry.sequence }
    ended = result.ended
  } catch {
    if (!ended) await write(formatter.box(zh ? '连接已结束' : 'Disconnected', zh ? '主窗口已结束或连接断开 · Enter 关闭' : 'Owner closed or disconnected · Enter to close', 'dim', 3))
    ended = true
    break
  }
  await new Promise(resolve => setTimeout(resolve, 200))
}
