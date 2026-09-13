import type { LocaleSetting } from './preferences.js'

export type Locale = 'en' | 'zh-CN'
const en = {
  language: 'Language', help: 'Help', status: 'Status', settings: 'Settings',
  you: 'you', assistant: 'assistant', error: 'error', success: 'success', finished: 'finished',
  workspaceChanges: 'Workspace changes', turns: 'turns', historyHint: 'History · Enter inspect · c continue in NEW session · Esc/q back',
  toolFocusHint: 'tools focused · ↑/↓ select · Enter details · Tab or Esc back to prompt',
  configMissing: 'Composition file unavailable; dshc could not read the config it launched with.',
  launchedWith: 'Launched with', baseComposition: 'Base composition', effectiveConfig: 'Effective requested configuration',
  configAuthority: 'This is the requested composition. The SDK does not expose a complete inventory of loaded runtime plugins.',
  configUsage: '/model <id> --yes · /provider <id> --yes · /reload [path] --yes\nChanges start a NEW session. /config fork creates a workspace patch.\nBundled backend: workspace patches apply over the shipped configuration; --runtime-config selects a separate base.\nProfile backend: configuration comes from official Profile sources.',
  patchLayer: 'Patch layer', noToolSelected: 'No tool call is selected.', toolEvicted: 'That tool call is no longer in local retention.',
  outcome: 'outcome', session: 'session', call: 'call', elapsed: 'elapsed', arguments: 'arguments', result: 'result',
  noResult: 'No result observed yet', noDescendants: 'No descendant activity observed for this session',
  capabilityBoundary: 'Harness boundary', capabilityLimits: 'prompt cancel: unavailable\nper-session close: unavailable\ndshc hard interrupt: Ctrl+C replaces the whole runtime and starts a fresh session.',
  terminalPlugins: 'Terminal plugins', renderers: 'Specialized renderers', commands: 'Commands',
  codingBaseline: 'Shipped default coding baseline: locally validated; not runtime discovery; overrides may differ. Profiles and read-only modes may expose fewer tools.',
  usageTitle: 'Token usage', activityTiming: 'Activity timing', timingCaveat: 'Observed request/tool spans can overlap across agents; they are not server-only latency.',
  startupSettings: 'Requested at runtime startup', settingSources: 'Setting sources',
  capabilities: 'Capability Explorer', runtimeConfig: 'Runtime Configuration', sessionTrace: 'Session Trace',
  agentTopology: 'Agent Topology', toolCall: 'Tool Call', context: 'Context', promptProjection: 'Prompt Projection', permissions: 'Permissions',
  localBusy: 'Local terminal command is running…', returnToTranscript: 'Esc / Enter / q · return to transcript',
  starting: 'starting', idle: 'idle', running: 'running', closing: 'closing', failed: 'failed',
  prompt: 'Prompt', tools: 'Tools', history: 'History', mode: 'Mode', style: 'Output style',
  queued: 'Queued: {count}', queuePaused: 'Queue paused; use /queue resume to send in this session.',
  pending: 'Pending until the next runtime start', saved: 'Preferences saved',
  restart: 'This change replaces the runtime and starts a NEW session. Repeat with --yes to apply.',
  languageChanged: 'Interface language: {locale}', emptyQueue: 'The queue is empty.',
  noDiff: 'No tracked changes in this selection.', diffTitle: 'Workspace changes (ownership is not inferred)',
  noMatches: 'No matching files.', editor: 'Opening external editor…',
  inputHint: 'Enter submit · Tab tools / complete · Ctrl+G editor · /history',
  busyHint: 'Enter queue · Ctrl+C interrupt · /queue manage pending messages',
  menuHint: '↑↓ select · Tab / Enter complete · Enter again execute · Esc close',
  choiceSystem: 'Follow system language', choiceQuestion: 'Follow the question language',
  choiceChinese: 'Simplified Chinese', choiceEnglish: 'English',
  choiceCode: 'Code and run tools in the workspace', choicePlan: 'Plan with read-only repository tools',
  choiceReview: 'Review with read-only repository tools', choiceResearch: 'Read repository and use configured Web tools',
  choiceDefault: 'Default output', choiceExplanatory: 'Explain decisions and reasoning', choiceLearning: 'Teach step by step',
  choiceUnstaged: 'Changes not yet staged', choiceStaged: 'Changes staged for commit',
  confirmCommand: 'Requested: {selection}\n{warning}\nTo apply: {command}',
  currentChoices: 'Current: {value}\nOptions: {options}',
  unknownCommand: 'Unknown command /{name}; use /help. Your input is kept for editing.',
  queuePausedShort: 'paused · /queue resume', moreChoices: '{count} more',
  fileHint: '↑↓ / Tab select file · Enter insert path · Esc close',
  evictedChars: '{count} characters evicted locally',
  backend: 'Runtime backend', requested: 'requested', observed: 'observed', unavailable: 'unavailable',
  helpPreferences: '/language [auto|zh-CN|en]\n/mode [code|plan|review|research] [--yes]\n/style [default|explanatory|learning] [--yes]\n/reply-language <auto|language-tag>\n/queue [list|remove N|edit N text|withdraw|resume]\n/template <name> [arguments]\n/diff [staged|unstaged] [file]',
  pluginInstalled: 'installed', pluginConfigured: 'configured', pluginBoot: 'startup verified',
  pluginFunctional: 'functional verification unavailable',
} as const
export type MessageKey = keyof typeof en
const zh: Record<MessageKey, string> = {
  language: '语言', help: '帮助', status: '状态', settings: '设置',
  you: '你', assistant: '助手', error: '错误', success: '成功', finished: '已结束',
  workspaceChanges: '工作区变更', turns: '轮次', historyHint: '历史 · Enter 查看 · c 交接到新会话 · Esc/q 返回',
  toolFocusHint: '工具侧栏 · ↑/↓ 选择 · Enter 详情 · Tab 或 Esc 返回输入',
  configMissing: '配置文件不可用；无法读取本次启动使用的配置。',
  launchedWith: '启动信息', baseComposition: '基础配置', effectiveConfig: '合并后的请求配置',
  configAuthority: '以下为启动时请求的配置。SDK 未提供已加载运行时插件的完整清单。',
  configUsage: '/model <id> --yes · /provider <id> --yes · /reload [路径] --yes\n修改会创建新会话。/config fork 创建工作区补丁。\n自带后端：工作区补丁叠加在自带配置上；--runtime-config 指定独立配置。\nProfile 后端：配置来自官方 Profile 配置来源。',
  patchLayer: '补丁层', noToolSelected: '尚未选择工具调用。', toolEvicted: '此工具调用已超出本地保留范围。',
  outcome: '结果状态', session: '会话', call: '调用', elapsed: '耗时', arguments: '参数', result: '结果',
  noResult: '尚未观察到结果', noDescendants: '尚未观察到当前会话的子 Agent 活动',
  capabilityBoundary: 'Harness 运行时边界', capabilityLimits: '暂不支持单次请求取消或单独关闭会话。Ctrl+C 将替换整个运行时并创建新会话。',
  terminalPlugins: '终端插件', renderers: '专用渲染器', commands: '命令',
  codingBaseline: '已在本地验证的自带编码工具；所选 Profile 和只读模式可能提供更少工具。',
  usageTitle: 'Token 用量', activityTiming: '任务耗时', timingCaveat: '请求与工具观测时段可能因多 Agent 而重叠，不代表纯服务端延迟。',
  startupSettings: '运行时启动时的请求配置', settingSources: '设置来源',
  capabilities: '能力查看器', runtimeConfig: '运行时配置', sessionTrace: '会话事件',
  agentTopology: 'Agent 关系', toolCall: '工具调用', context: '上下文', promptProjection: '提示词视图', permissions: '权限',
  localBusy: '正在执行终端命令…', returnToTranscript: 'Esc / Enter / q · 返回对话',
  starting: '启动中', idle: '空闲', running: '运行中', closing: '关闭中', failed: '失败',
  prompt: '输入', tools: '工具', history: '历史', mode: '工作模式', style: '输出风格',
  queued: '待发送：{count}', queuePaused: '队列已暂停；使用 /queue resume 在当前会话中发送。',
  pending: '待下次运行时启动后生效', saved: '偏好设置已保存',
  restart: '此操作将替换运行时并创建新会话。添加 --yes 再次执行以应用。',
  languageChanged: '界面语言：{locale}', emptyQueue: '待发送队列为空。',
  noDiff: '当前选项下没有已跟踪文件的修改。', diffTitle: '工作区变更（不推断修改归属）',
  noMatches: '没有匹配的文件。', editor: '正在打开外部编辑器…',
  inputHint: 'Enter 发送 · Tab 补全 · Ctrl+G 编辑器 · /history 历史对话',
  busyHint: 'Enter 加入队列 · Ctrl+C 中断 · /queue 管理待发送消息',
  menuHint: '↑↓ 选择 · Tab / Enter 补全 · 再按 Enter 执行 · Esc 关闭',
  choiceSystem: '跟随系统语言', choiceQuestion: '跟随提问语言',
  choiceChinese: '简体中文', choiceEnglish: '英文',
  choiceCode: '修改代码并运行工作区工具', choicePlan: '只读仓库，制定实施计划',
  choiceReview: '只读仓库，审阅代码问题', choiceResearch: '只读仓库及已配置的 Web 工具',
  choiceDefault: '默认输出', choiceExplanatory: '解释选择和原因', choiceLearning: '分步讲解，帮助学习',
  choiceUnstaged: '查看尚未暂存的修改', choiceStaged: '查看已暂存、待提交的修改',
  confirmCommand: '准备切换：{selection}\n{warning}\n确认执行：{command}',
  currentChoices: '当前：{value}\n可选值：{options}',
  unknownCommand: '未知命令 /{name}；可用 /help 查看。已保留输入，便于修改。',
  queuePausedShort: '已暂停 · /queue resume', moreChoices: '还有 {count} 项',
  fileHint: '↑↓ / Tab 选择文件 · Enter 插入路径 · Esc 关闭',
  evictedChars: '本地已省略 {count} 字符',
  backend: '运行时后端', requested: '请求配置', observed: '已观察', unavailable: '不可用',
  helpPreferences: '/language [auto|zh-CN|en] 界面语言\n/mode [code|plan|review|research] [--yes] 工作模式\n/style [default|explanatory|learning] [--yes] 输出风格\n/reply-language <auto|语言标签> 回复语言\n/queue [list|remove N|edit N text|withdraw|resume] 待发送队列\n/template <名称> [参数] 文本模板\n/diff [staged|unstaged] [文件] 只读变更审阅',
  pluginInstalled: '已安装', pluginConfigured: '已配置', pluginBoot: '启动验证通过',
  pluginFunctional: '功能验证不可用',
}
export const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en, 'zh-CN': zh }
export function resolveLocale(value: LocaleSetting = 'auto', env: NodeJS.ProcessEnv = process.env): Locale {
  if (value !== 'auto') return value
  const system = env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale
  return /^zh(?:[-_]|$)/i.test(system) ? 'zh-CN' : 'en'
}
export function translate(locale: Locale, key: MessageKey, params: Record<string, string | number> = {}): string {
  return (CATALOGS[locale][key] ?? en[key]).replace(/\{(\w+)\}/g, (token: string, name: string) => String(params[name] ?? token))
}

/** Only call on UI-owned labels, never provider/tool text. */
export function uiLabel(locale: Locale, label: string): string {
  if (locale === 'en') return label
  const key = (Object.keys(en) as MessageKey[]).find(key => en[key] === label || key === label)
  return key === undefined ? label : translate(locale, key)
}
