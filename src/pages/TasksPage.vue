<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import { newId, nowIso } from '@shared/index'
import type { Task } from '@shared/index'

const store = useAppStore()
const selected = ref<Set<string>>(new Set())
const expanded = ref<Set<string>>(new Set())
const showCreate = ref(false)
const form = ref({ title: '', description: '', assigneeAgentId: '', reviewerAgentId: '', actionMode: 'do' as 'do' | 'ask' | 'delegate', dependsOn: '', inputContext: '' })
const result = ref('')
const selectedFileId = ref<string | null>(null)
const selectedFile = computed(() => store.files.find((file) => file.id === selectedFileId.value))

const statuses: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-600', ready: 'bg-blue-50 text-blue-700',
  running: 'bg-indigo-50 text-indigo-700', waiting_approval: 'bg-amber-50 text-amber-700',
  completed: 'bg-emerald-50 text-emerald-700', failed: 'bg-rose-50 text-rose-700',
  cancelled: 'bg-slate-100 text-slate-500'
}

const tree = computed(() => {
  const tasks = store.teamTasks
  const children = new Map<string | undefined, Task[]>()
  for (const task of tasks) {
    const parent = task.dependsOn?.[0] ?? undefined
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)!.push(task)
  }
  return children
})

const board = computed(() => {
  const columns = ['todo', 'in_progress', 'review', 'approved', 'done', 'blocked'] as const
  return columns.map((key) => ({
    key,
    label: { todo: '待办', in_progress: '进行中', review: '审查中', approved: '已批准', done: '完成', blocked: '阻塞' }[key],
    tasks: store.teamTasks.filter((task) => (task.boardColumn ?? 'todo') === key)
  }))
})
const activeReviews = computed(() => store.reviews.filter((review) => ['requested', 'in_review', 'lead_signoff'].includes(review.status)))

function toggleSet(set: Set<string>, key: string) {
  const next = new Set(set)
  if (next.has(key)) next.delete(key); else next.add(key)
  return next
}

onMounted(async () => {
  await Promise.all([store.loadMessages(), store.loadReviews()])
})

async function createTask() {
  const task: Partial<Task> = {
    taskId: newId('task'), teamId: store.currentTeamId,
    title: form.value.title || '未命名任务', description: form.value.description,
    assigneeAgentId: form.value.assigneeAgentId || undefined,
    reviewerAgentId: form.value.reviewerAgentId || undefined,
    actionMode: form.value.actionMode,
    dependsOn: form.value.dependsOn.split(/[\s,]+/).filter(Boolean),
    inputContext: form.value.inputContext,
    status: 'pending', createdAt: nowIso()
  }
  await store.saveTask(task)
  form.value = { title: '', description: '', assigneeAgentId: '', reviewerAgentId: '', actionMode: 'do', dependsOn: '', inputContext: '' }
  showCreate.value = false
}

function renderTree(parent: string | undefined, depth: number): Array<{ task: Task; depth: number }> {
  const items = tree.value.get(parent) ?? []
  const output: Array<{ task: Task; depth: number }> = []
  for (const task of items) {
    output.push({ task, depth })
    output.push(...renderTree(task.taskId, depth + 1))
  }
  return output
}

async function runTasks() {
  await store.runTasks([...selected.value])
  result.value = store.notice
}

async function saveTaskTemplate() {
  const task = store.teamTasks.find((item) => item.taskId === [...selected.value][0])
  if (!task) { result.value = '请先选择一个任务'; return }
  await store.saveTemplate('task', task.title, task as unknown as Record<string, unknown>, task.description)
  result.value = '已保存为任务模板'
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-end justify-between">
      <div>
        <h1 class="text-xl font-bold text-slate-900">任务执行</h1>
        <p class="text-[13px] text-slate-500 mt-1">任务树、实时事件流与权限审批；失败任务可重试。</p>
      </div>
      <div class="flex gap-2">
        <button class="btn" @click="showCreate = !showCreate">{{ showCreate ? '收起表单' : '+ 新建任务' }}</button>
        <button class="btn" @click="saveTaskTemplate">存为模板</button>
        <button class="btn" :disabled="!store.currentRunId" @click="store.cancelRun()">取消运行</button>
        <button class="btn btn-primary" :disabled="store.busy || !selected.size" @click="runTasks()">
          {{ store.busy ? '运行中…' : `运行选中 (${selected.size})` }}
        </button>
      </div>
    </div>

    <div v-if="showCreate" class="panel p-5 grid grid-cols-5 gap-3 items-end">
      <div class="col-span-1"><label class="label">标题</label><input v-model="form.title" class="input" /></div>
      <div class="col-span-2"><label class="label">描述</label><input v-model="form.description" class="input" /></div>
      <div><label class="label">指派 Agent</label><select v-model="form.assigneeAgentId" class="input"><option value="">未指派</option><option v-for="agent in store.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></div>
      <div><label class="label">依赖任务 ID（空格分隔）</label><input v-model="form.dependsOn" class="input mono" /></div>
      <div><label class="label">审查 Agent</label><select v-model="form.reviewerAgentId" class="input"><option value="">未指定</option><option v-for="agent in store.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></div>
      <div><label class="label">动作模式</label><select v-model="form.actionMode" class="input"><option value="do">DO · 执行</option><option value="ask">ASK · 只读</option><option value="delegate">DELEGATE · 转交</option></select></div>
      <div class="col-span-4"><label class="label">补充上下文</label><input v-model="form.inputContext" class="input" /></div>
      <button class="btn btn-primary" @click="createTask">保存任务</button>
    </div>

    <div class="grid grid-cols-6 gap-2">
      <div v-for="column in board" :key="column.key" class="panel p-3 min-h-28">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[12px] font-semibold text-slate-600">{{ column.label }}</span>
          <span class="badge badge-neutral">{{ column.tasks.length }}</span>
        </div>
        <div class="space-y-1 max-h-32 overflow-auto scroll-thin">
          <button v-for="task in column.tasks" :key="task.taskId" class="block w-full text-left text-[11px] px-2 py-1 rounded bg-slate-50 hover:bg-indigo-50 truncate" @click="selected = toggleSet(selected, task.taskId)">
            {{ task.title }}
          </button>
          <div v-if="!column.tasks.length" class="text-[11px] text-slate-300">空</div>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-5 gap-4">
      <div class="panel col-span-3 overflow-hidden">
        <table class="table">
          <thead><tr><th></th><th>任务</th><th>Agent</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="row in renderTree(undefined, 0)" :key="row.task.taskId">
              <td><input type="checkbox" :checked="selected.has(row.task.taskId)" @change="selected = toggleSet(selected, row.task.taskId)" /></td>
              <td>
                <div :style="{ paddingLeft: row.depth * 16 + 'px' }">
                  <div class="font-medium">{{ row.depth ? '↳ ' : '' }}{{ row.task.title }}</div>
                  <div class="text-[11px] text-slate-400">{{ row.task.taskId }} · {{ row.task.description }}</div>
                  <div v-if="row.task.outputSummary" class="text-[11px] text-slate-500 mt-1 truncate max-w-md">{{ row.task.outputSummary }}</div>
                  <div v-if="row.task.errorMessage" class="text-[11px] text-rose-600 mt-1">{{ row.task.errorMessage }}</div>
                </div>
              </td>
              <td class="text-[12px]">{{ store.agentById(row.task.assigneeAgentId)?.name ?? '未指派' }}</td>
              <td><span class="badge" :class="statuses[row.task.status]">{{ row.task.status }}</span></td>
              <td>
                <button v-if="row.task.status === 'failed'" class="text-[12px] text-indigo-600" @click="store.retryTask(row.task.taskId)">重试</button>
                <span v-else class="text-slate-300">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="col-span-2 space-y-4">
        <div class="panel p-5">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-sm font-semibold">实时事件流</h2>
            <span class="text-[11px] text-slate-400">{{ store.events.length }} 条</span>
          </div>
          <div class="space-y-2 max-h-72 overflow-auto scroll-thin mono text-[11px]">
            <div v-for="event in store.events.slice(0, 60)" :key="event.id" class="border-l-2 pl-2" :class="event.type.includes('failed') ? 'border-rose-400' : event.type.includes('completed') ? 'border-emerald-400' : 'border-indigo-300'">
              <div class="text-slate-600">{{ event.timestamp.slice(11, 23) }} · {{ event.type }}</div>
              <div class="text-slate-800 break-all">{{ event.message }}</div>
            </div>
            <div v-if="!store.events.length" class="text-slate-400">暂无事件</div>
          </div>
        </div>

        <div class="panel p-5">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-sm font-semibold">文件 Diff</h2>
            <span class="text-[11px] text-slate-400">{{ store.files.length }} 个变更</span>
          </div>
          <div class="space-y-1 max-h-44 overflow-auto scroll-thin text-[12px]">
            <button v-for="file in store.files.slice(0, 40)" :key="file.id" class="w-full text-left px-2 py-1 rounded hover:bg-slate-50" :class="selectedFileId === file.id ? 'bg-indigo-50 text-indigo-700' : ''" @click="selectedFileId = file.id">
              {{ file.binary ? '[二进制] ' : '' }}{{ file.path }}
            </button>
            <div v-if="!store.files.length" class="text-slate-400">运行后显示文件变更</div>
          </div>
          <pre v-if="selectedFile" class="mt-3 p-3 rounded-lg bg-slate-900 text-slate-100 text-[11px] mono overflow-auto max-h-48 scroll-thin">{{ selectedFile.diff || '(无文本差异)' }}</pre>
        </div>

        <div class="panel p-5">
          <h2 class="text-sm font-semibold mb-3">审查循环</h2>
          <div v-for="review in activeReviews" :key="review.id" class="border-b border-slate-100 py-2 text-[12px]">
            <div class="flex items-center justify-between">
              <span class="font-medium">{{ store.teamTasks.find((t) => t.taskId === review.taskId)?.title ?? review.taskId }}</span>
              <span class="badge badge-warn">{{ review.status }}</span>
            </div>
            <div class="text-slate-500 mt-1">{{ review.summary || '等待审查结论' }}</div>
            <div class="flex gap-2 mt-2" v-if="review.status === 'requested'">
              <button class="btn !py-1" @click="api.reviews.start(review.id).then(store.loadReviews)">开始审查</button>
            </div>
            <div class="flex gap-2 mt-2" v-if="review.status === 'in_review'">
              <button class="btn btn-primary !py-1" @click="store.resolveReview(review.id, 'approve', { summary: '人工批准通过' })">通过</button>
              <button class="btn !py-1" @click="store.resolveReview(review.id, 'changes_requested', { findings: '需要修改' })">要求修改</button>
            </div>
            <div class="flex gap-2 mt-2" v-if="review.status === 'lead_signoff'">
              <button class="btn !py-1" @click="store.leadSignoff(review.id, 'approve')">Lead 签核</button>
              <button class="btn btn-primary !py-1" @click="store.humanApprove(review.taskId)">人工最终批准</button>
            </div>
          </div>
          <button v-if="selected.size === 1" class="btn !py-1 mt-2" @click="store.requestReview([...selected][0])">请求审查选中任务</button>
          <div v-if="!activeReviews.length" class="text-slate-400">暂无进行中的审查</div>
        </div>

        <div class="panel p-5">
          <h2 class="text-sm font-semibold mb-3">Agent 消息流</h2>
          <div class="space-y-2 max-h-44 overflow-auto scroll-thin text-[12px]">
            <div v-for="message in store.messages.slice(-30).reverse()" :key="message.id" class="border-b border-slate-100 py-1">
              <div class="text-slate-500 text-[11px]">{{ message.createdAt.slice(11, 19) }} · {{ message.kind }} · {{ store.agentById(message.fromAgentId)?.name ?? message.sender }} → {{ store.agentById(message.toAgentId)?.name ?? message.toAgentId ?? '团队' }}</div>
              <div class="text-slate-700 break-all">{{ message.summary || message.content.slice(0, 120) }}</div>
            </div>
            <div v-if="!store.messages.length" class="text-slate-400">暂无 Agent 消息</div>
          </div>
        </div>

        <div class="panel p-5">
          <h2 class="text-sm font-semibold mb-3">任务模板</h2>
          <div v-for="template in store.templates.filter((t) => t.kind === 'task')" :key="template.id" class="flex items-center justify-between border-b border-slate-100 py-2 text-[12px]">
            <span>{{ template.name }}</span>
            <button class="text-indigo-600" @click="store.applyTemplate(template.id, { teamId: store.currentTeamId })">应用</button>
          </div>
          <div v-if="!store.templates.filter((t) => t.kind === 'task').length" class="text-slate-400">暂无任务模板</div>
        </div>

        <div v-if="store.pendingApprovals.length" class="panel p-5 border-amber-200">
          <h2 class="text-sm font-semibold text-amber-700 mb-3">待审批操作</h2>
          <div v-for="approval in store.pendingApprovals" :key="approval.id" class="mb-3 text-[12px]">
            <div class="font-medium">
              <span v-if="approval.risk === 'high'" class="badge badge-warn mr-1">高风险</span>{{ approval.title }}
            </div>
            <div class="text-slate-500 break-all">{{ approval.detail }}</div>
            <div v-if="approval.path || approval.command || approval.reason" class="text-slate-400 mono break-all mt-1">
              {{ approval.path || approval.command || approval.reason }}
            </div>
            <div class="flex gap-2 mt-2">
              <button class="btn btn-primary !py-1" @click="store.resolveApproval(approval.id, 'approved')">允许</button>
              <button class="btn !py-1" @click="store.resolveApproval(approval.id, 'rejected')">拒绝</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
