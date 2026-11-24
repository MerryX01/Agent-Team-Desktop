import type { ActionMode, Task, Team } from '@shared/index'

/**
 * 动作模式优先级：任务显式指定 > 团队默认值 > DO。
 * 未显式设置的字段保持可选，因此这里必须自行兜底。
 */
export function resolveActionMode(task: Task, team: Team): ActionMode {
  return task.actionMode ?? team.defaultActionMode ?? 'do'
}

export function isDelegateMode(mode: ActionMode): boolean {
  return mode === 'delegate'
}

export function isReadOnlyMode(mode: ActionMode): boolean {
  return mode === 'ask'
}

/**
 * 生成注入到执行提示中的动作模式约束。
 * rosterNames 必须是名册中的精确姓名，不得由调用方杜撰。
 */
export function buildActionModeInstruction(mode: ActionMode, rosterNames: string[] = []): string {
  const names = rosterNames.map((name) => name.trim()).filter(Boolean)
  const roster = names.length
    ? `可用队友精确姓名：${names.join('、')}。转交时只能原样使用以上姓名，不得杜撰、猜测或改写接收人。`
    : '当前没有可用的队友名册，无法执行转交；遇到需要转交的情形应直接报告。'

  switch (mode) {
    case 'do':
      return [
        '【动作模式：DO（执行）】',
        '你可以读取文件、运行读写命令、修改工作区文件，并更新任务状态与结果。',
        '完成后提交清晰的结果摘要；高风险操作仍须遵守权限策略。'
      ].join('\n')
    case 'ask':
      return [
        '【动作模式：ASK（只读）】',
        '严格只读：只可查看文件、任务与消息，不得修改任何文件、任务或状态。',
        '不得运行写入命令，不得执行任何有副作用的动作；只输出分析、建议或答复。',
        '如需改动，请说明应由谁执行，而不要自己动手。'
      ].join('\n')
    case 'delegate':
      return [
        '【动作模式：DELEGATE（转交）】',
        '你不得自己实现该任务。必须把任务连同完整上下文（目标、背景、依赖与验收标准）转交给指定队友，由队友执行。',
        '转交时必须指定一名队友，并使用名册中的精确姓名，不得杜撰或改写接收人。',
        roster
      ].join('\n')
  }
}
