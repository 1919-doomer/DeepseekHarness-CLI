import { translate, type Locale, type MessageKey } from '../i18n.js'

const choices: Record<string, readonly (readonly [string, MessageKey])[]> = {
  language: [['auto', 'choiceSystem'], ['zh-CN', 'choiceChinese'], ['en', 'choiceEnglish']],
  'reply-language': [['auto', 'choiceQuestion'], ['zh-CN', 'choiceChinese'], ['en', 'choiceEnglish']],
  mode: [['code', 'choiceCode'], ['plan', 'choicePlan'], ['review', 'choiceReview'], ['research', 'choiceResearch']],
  style: [['default', 'choiceDefault'], ['explanatory', 'choiceExplanatory'], ['learning', 'choiceLearning']],
  diff: [['unstaged', 'choiceUnstaged'], ['staged', 'choiceStaged']],
}

/** Suggest inert text only; never synthesize --yes or execute a selection. */
export function commandArgumentChoices(input: string, locale: Locale) {
  const match = /^\/([\w-]+)[ \t]+([^\s]*)$/.exec(input)
  if (!match) return []
  const name = match[1]!.toLowerCase()
  const prefix = match[2]!.toLowerCase()
  return (choices[name] ?? []).filter(([value]) => value.toLowerCase().startsWith(prefix))
    .map(([value, label]) => ({ name: `${name} ${value}`, summary: translate(locale, label) }))
}
