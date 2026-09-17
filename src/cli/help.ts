import type { Locale } from '../i18n.js'
import { HELP_TEXT } from './args.js'

export function cliHelp(locale: Locale): string {
  if (locale === 'en') return HELP_TEXT
  return `DeepSeek Harness Console

用法：
  dshc [选项]                         在终端中启动交互界面
  dshc [选项] <提问>                  执行一次后退出
  dshc run [选项] <提问>              显式单次执行
  dshc doctor [选项]                  检查环境与运行时，不请求模型
  echo "提问" | dshc                  从标准输入读取一次提问
  dshc --interactive                  也支持管道中的逐行脚本

选项：
  -C, --workspace <路径>              工作区，默认当前目录
      --provider <标识>              提供方，默认 deepseek-official
      --model <标识>                 模型，默认 deepseek-flash；保留显式选择
      --session <标识>               初始或单次运行的会话标识
      --max-tokens <数量>             输出 token 上限，必须为正整数
      --activity-timeout-ms <毫秒>    从接收提问到空闲状态的超时
      --request-timeout-ms <毫秒>     单个 JSON-RPC 请求超时
      --locale auto|zh-CN|en         界面语言，auto 跟随系统
      --reply-language auto|<标签>    回复语言，auto 跟随提问
      --mode code|plan|review|research
                                     编码、规划、审阅或研究模式
      --style default|explanatory|learning
                                     默认、解释或教学风格
      --reasoning-effort <标识>       适配器定义的推理配置
      --runtime bundled|dsh-profile  运行时后端，默认自带运行时
      --dsh-profile <名称>            官方 SDK Profile；managed 为受管 Profile
      --runtime-config <路径>        显式 Cordis 配置，仅自带后端支持
      --dev                          可信开发工作台，仅自带后端的交互编码模式
      --interactive                  强制交互循环，支持管道输入
      --json                         单次执行或 doctor 输出机器可读 JSON
      --debug                        兼容性与未知事件诊断
      --no-animation                 关闭开屏及状态动画
      --no-subagent-windows          子 Agent 输出保留在当前窗口（Windows）
  -h, --help                         显示帮助
  -v, --version                      显示版本

设置优先级：命令行 > 工作区 .dshc/settings.json > 用户 ~/.dshc/settings.json > 默认。
配置不保存凭据。原始工具输出、JSON 字段、错误码和命令名不随界面语言变化。

交互界面：
  /help 列出当前命令；@路径 + Tab 补全文件引用；Ctrl+G 打开外部编辑器。
  /language 切换界面；/reply-language 设置回复语言；/mode、/style 切换工作配置。
  /plan 进入只读规划；/sidebar [overview|tools] 切换概览和工具侧栏。
  /template 展开文本模板；/queue 管理待发送消息；/diff 只读查看工作区差异。
  /profile 选择后端；Profile 后端的 /plugin 管理 Bundle 的候选安装和回退。
  脚本交互保留 /help /status /session /new /clear /exit。

运行时设置切换会重新启动运行时并创建新会话。模型运行时 Ctrl+C 通过替换整个
运行时实现中断；公共协议没有单次提问取消、会话关闭或真正会话恢复接口。
`
}
