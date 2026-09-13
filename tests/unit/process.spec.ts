import { expect, it } from 'vitest'
import { captureProcess } from '../../src/upstream/process.js'

it('bounds overflowing subprocess output and aborts an owned child without hanging on pipes', async () => {
  await expect(captureProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000)); setInterval(()=>{},1000)'],
    { cwd: process.cwd(), maxBytes: 100 })).rejects.toThrow('display limit')
  const controller = new AbortController()
  const task = captureProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), signal: controller.signal })
  controller.abort(new Error('fixture stop'))
  await expect(task).rejects.toThrow('fixture stop')
}, 10_000)
