import type { TerminalPluginSpec } from './api.js'

const commandZh = {
  help: '显示当前终端命令与能力说明', status: '显示运行时、设置来源、用量及会话状态', session: '显示当前会话标识',
  new: '创建新会话，保留当前运行时', clear: '清空本地显示，保留运行时历史', plugins: '查看运行时能力与终端插件',
  trace: '查询本地保留的事件；/trace help 显示筛选与分页', agents: '显示根 Agent 与子 Agent 关系', tools: '显示或隐藏工具侧栏', exit: '关闭运行时并退出',
  context: '查看用量、上下文容量与压缩事件', prompt: '查看本地提示词配置层', permissions: '查看运行时权限边界与审批事件',
  history: '只读查看历史对话并审阅交接内容', config: '查看配置；/config fork 创建工作区补丁', model: '切换模型并创建新会话',
  provider: '切换模型提供方并创建新会话', reload: '重新启动运行时，可指定配置路径', plugin: '查看或管理 Harness 插件与 Profile Bundle',
  language: '切换界面语言', 'reply-language': '设置回复语言，下次运行时启动生效', mode: '切换工作模式并创建新会话',
  style: '切换输出风格并创建新会话', effort: '设置适配器推理配置并创建新会话', profile: '选择自带后端或官方 SDK Profile',
  diff: '只读查看 staged/unstaged 工作区差异', template: '将文本模板展开到输入框', edit: '打开外部编辑器',
  queue: '查看、编辑、删除、撤回或继续待发送队列', cordis: '检查可信 Cordis 开发工作台',
} as const

/** First-party catalog augmentation; external API v1 plugins remain optional. */
export function withFirstPartyLocales(plugin: TerminalPluginSpec): TerminalPluginSpec {
  const zh: Record<string, string> = {}
  for (const command of plugin.commands ?? []) {
    const text = commandZh[command.name as keyof typeof commandZh]
    if (text) zh[`command.${command.name}.summary`] = text
  }
  return { ...plugin, locales: { ...plugin.locales, 'zh-CN': { ...zh, ...plugin.locales?.['zh-CN'] } } }
}
