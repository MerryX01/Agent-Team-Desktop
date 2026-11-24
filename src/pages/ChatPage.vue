<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app'
import { newId, nowIso } from '@shared/index'
import type { AgentMessage, Task } from '@shared/index'

const store = useAppStore()
const text = ref('')
const target = ref('all')
const sending = ref(false)

const members = computed(() => store.members.length ? store.members.map((m) => store.agentById(m.agentId)).filter(Boolean) : store.agents)
const messages = computed(() => store.messages.filter((message) => !message.taskId || true).slice(-200))

onMounted(async () => {
  await Promise.all([store.loadMessages(), store.loadReviews()])
})

async function send(asTask = false) {
  const content = text.value.trim()
  if (!content || sending.value) return
  sending.value = true
  try {
    const toAgentId = target.value === 'all' ? undefined : target.value
    await store.sendMessage({
      teamId: store.currentTeamId,
      fromAgentId: 'user',
      toAgentId,
      sender: '群主',
      content,
      summary: content.slice(0, 60),
      kind: 'user'
    })
    if (asTask) {
      const task: Partial<Task> = {
        taskId: newId('task'),
        teamId: store.currentTeamId,
        title: content.length > 40 ? `${content.slice(0, 40)}…` : content,
        description: content,
        assigneeAgentId: toAgentId,
        status: 'pending',
        createdAt: nowIso()
      }
      await store.saveTask(task)
      store.notice = '消息已发送，并创建为任务'
    } else {
      store.notice = '消息已发送到群聊'
    }
    text.value = ''
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="grid grid-cols-5 gap-4 h-[calc(100vh-120px)]">
    <div class="panel col-span-3 flex flex-col overflow-hidden">
      <div class="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
        <span class="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">👥</span>
        <div class="flex-1 min-w-0">
          <div class="font-semibold">{{ store.currentTeam?.name ?? '项目群聊' }}</div>
          <div class="text-[11px] text-slate-400 mono truncate">{{ store.currentTeam?.defaultWorkspace || '未绑定项目文件夹' }}</div>
        </div>
        <span class="badge badge-native">群主：你</span>
        <RouterLink to="/teams" class="text-[12px] text-indigo-600">成员管理</RouterLink>
      </div>

      <div class="flex-1 overflow-auto scroll-thin p-5 space-y-3 bg-slate-50/60">
        <div v-for="message in messages" :key="message.id" class="flex gap-3" :class="message.fromAgentId === 'user' ? 'flex-row-reverse' : ''">
          <span class="w-8 h-8 rounded-lg flex items-center justify-center text-[12px] shrink-0"
            :class="message.fromAgentId === 'user' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'">
            {{ message.fromAgentId === 'user' ? '主' : (store.agentById(message.fromAgentId)?.name ?? '系').slice(0, 1) }}
          </span>
          <div class="max-w-[72%]">
            <div class="text-[11px] text-slate-400 mb-1" :class="message.fromAgentId === 'user' ? 'text-right' : ''">
              {{ message.fromAgentId === 'user' ? '群主（你）' : (store.agentById(message.fromAgentId)?.name ?? message.sender) }}
              <span v-if="message.toAgentId"> → {{ store.agentById(message.toAgentId)?.name ?? message.toAgentId }}</span>
              · {{ message.createdAt.slice(11, 16) }}
            </div>
            <div class="rounded-xl px-3 py-2 text-[13px] whitespace-pre-wrap break-all"
              :class="message.fromAgentId === 'user' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-700'">
              {{ message.content }}
            </div>
            <div v-if="message.summary && message.summary !== message.content" class="text-[10px] text-slate-400 mt-1">{{ message.summary }}</div>
          </div>
        </div>
        <div v-if="!messages.length" class="text-center text-[13px] text-slate-400 py-20">
          群里还没有消息。发送第一条指令，或到成员管理页拉 Agent 入群。
        </div>
      </div>

      <div class="border-t border-slate-200 p-4 space-y-2">
        <div class="flex gap-2">
          <select v-model="target" class="input !w-44">
            <option value="all">发送给全群</option>
            <option v-for="agent in members" :key="agent!.id" :value="agent!.id">{{ agent!.name }}</option>
          </select>
          <input v-model="text" class="input" placeholder="输入任务、问题或指令；Enter 发送" @keydown.enter.prevent="send(false)" />
        </div>
        <div class="flex justify-end gap-2">
          <button class="btn" :disabled="sending || !text.trim()" @click="send(true)">发送并建任务</button>
          <button class="btn btn-primary" :disabled="sending || !text.trim()" @click="send(false)">发送</button>
        </div>
      </div>
    </div>

    <div class="col-span-2 space-y-4">
      <div class="panel p-5">
        <h2 class="text-sm font-semibold mb-4">群内 Agent</h2>
        <div v-for="member in members" :key="member!.id" class="flex items-center gap-3 border-b border-slate-100 py-2">
          <span class="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center text-[12px]">{{ member!.name.slice(0, 1) }}</span>
          <div class="flex-1 min-w-0">
            <div class="text-[13px] font-medium truncate">{{ member!.name }}</div>
            <div class="text-[11px] text-slate-400">{{ store.members.find((m) => m.agentId === member!.id)?.role ?? member!.role }} · {{ member!.installed ? '在线可用' : '未安装' }}</div>
          </div>
          <button class="text-[12px] text-indigo-600" @click="target = member!.id">私聊</button>
        </div>
        <div v-if="!members.length" class="text-[12px] text-slate-400">还没有成员入群</div>
      </div>

      <div class="panel p-5">
        <h2 class="text-sm font-semibold mb-3">群任务概览</h2>
        <div class="grid grid-cols-4 gap-2 text-center">
          <div v-for="status in ['pending','running','review','done']" :key="status" class="rounded-lg bg-slate-50 py-2">
            <div class="text-lg font-bold">{{ store.teamTasks.filter((t) => status === 'review' ? t.boardColumn === 'review' : status === 'done' ? t.status === 'completed' : t.status === status).length }}</div>
            <div class="text-[10px] text-slate-400">{{ { pending: '待办', running: '进行中', review: '审查中', done: '完成' }[status] }}</div>
          </div>
        </div>
        <RouterLink to="/tasks" class="btn w-full mt-3">查看任务详情 →</RouterLink>
      </div>
    </div>
  </div>
</template>
