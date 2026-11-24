<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import { isPreviewMode } from '../api'
import type { AgentDefinition, AgentHealth } from '@shared/index'

const store = useAppStore()
const text = ref('')
const target = ref('all')
const scroller = ref<HTMLElement | null>(null)
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
let autoProbed = false

const HEALTH_META: Record<AgentHealth, { label: string; cls: string; dot: string }> = {
  ready: { label: '可用', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  'no-quota': { label: '无额度', cls: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  'login-required': { label: '未登录', cls: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500' },
  'not-installed': { label: '未安装', cls: 'bg-slate-100 text-slate-500 border-slate-200', dot: 'bg-slate-400' },
  timeout: { label: '应答超时', cls: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  error: { label: '异常', cls: 'bg-rose-50 text-rose-700 border-rose-200', dot: 'bg-rose-500' },
  skipped: { label: '已跳过', cls: 'bg-slate-100 text-slate-500 border-slate-200', dot: 'bg-slate-400' },
  unknown: { label: '未体检', cls: 'bg-slate-100 text-slate-500 border-slate-200', dot: 'bg-slate-300' }
}

const members = computed<AgentDefinition[]>(() => {
  const list = store.members.length
    ? store.members.map((member) => store.agentById(member.agentId))
    : store.agents
  return list.filter((agent): agent is AgentDefinition => Boolean(agent))
})
const messages = computed(() => store.messages.slice(-200))
const live = computed(() => store.chatLiveList)
const chatRun = computed(() => store.chatRun)
const readyCount = computed(() => members.value.filter((agent) => agent.health === 'ready').length)
const runActive = computed(() => store.dispatching && chatRun.value?.status === 'running')
const gatePassed = computed(() => chatRun.value?.gate?.passed === true)
const deliverableMessage = computed(() => {
  const deliverable = chatRun.value?.deliverable?.trim()
  if (!deliverable) return undefined
  return [...messages.value].reverse().find((message) => message.kind === 'deliverable')
})

function roleOf(agentId?: string): string {
  return store.members.find((member) => member.agentId === agentId)?.role ?? store.agentById(agentId)?.role ?? 'developer'
}
function healthMeta(agent: AgentDefinition) { return HEALTH_META[agent.health ?? 'unknown'] }
function agentOf(agentId?: string) { return store.agentById(agentId) }
function displayName(agentId?: string, fallback = '成员'): string {
  if (agentId === 'user') return '群主（你）'
  return store.agentById(agentId)?.name ?? fallback
}
function initial(name?: string): string {
  return (name ?? '?').trim().slice(0, 2).toUpperCase()
}
function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.round((now.value - startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}
function phaseMeta(phase: string): { label: string; cls: string } {
  if (phase === 'connecting') return { label: '连接中', cls: 'bg-slate-100 text-slate-500' }
  if (phase === 'synthesis') return { label: '汇总交付', cls: 'bg-violet-50 text-violet-700' }
  if (phase === 'completed') return { label: '已完成', cls: 'bg-emerald-50 text-emerald-700' }
  if (phase === 'failed') return { label: '失败', cls: 'bg-rose-50 text-rose-700' }
  return { label: '思考中', cls: 'bg-indigo-50 text-indigo-700' }
}
function toggleThought(messageId: string) {
  showThoughts.value[messageId] = !thoughtVisible(messageId, store.chatLive[messageId]?.phase ?? 'completed')
}
const showThoughts = ref<Record<string, boolean>>({})
function thoughtVisible(messageId: string, phase: string): boolean {
  if (showThoughts.value[messageId] !== undefined) return showThoughts.value[messageId]
  return phase !== 'completed'
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function inline(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}
function renderMarkdown(markdown: string): string {
  const out: string[] = []
  let inList = false
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false } }
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { closeList(); continue }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = Math.min(4, heading[1].length + 2)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  return out.join('')
}

function scrollToBottom() {
  void nextTick(() => {
    const element = scroller.value
    if (element) element.scrollTop = element.scrollHeight
  })
}
watch(() => messages.value.length, scrollToBottom)
watch(() => live.value.map((item) => `${item.messageId}:${item.output.length}:${item.thought.length}:${item.phase}`).join('|'), scrollToBottom)

async function send() {
  const content = text.value.trim()
  if (!content || store.dispatching) return
  text.value = ''
  showThoughts.value = {}
  try {
    await store.dispatchChat(content, target.value === 'all' ? undefined : target.value)
  } catch (error) {
    text.value = content
    store.notice = error instanceof Error ? error.message : String(error)
  }
}
async function sendOnly() {
  const content = text.value.trim()
  if (!content) return
  await store.sendMessage({
    teamId: store.currentTeamId, fromAgentId: 'user', sender: '群主',
    content, summary: content.slice(0, 60), kind: 'user'
  })
  text.value = ''
  store.notice = '消息已发送到群聊（未触发协同）'
}
function useExample(example: string) {
  text.value = example
}
function privateChat(agentId: string) {
  target.value = agentId
  store.notice = `已切换到 ${displayName(agentId)} 私聊：下一条指令只由它应答`
}

onMounted(async () => {
  await Promise.all([store.loadMessages(), store.loadReviews(), store.loadChatRuns()])
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
  if (!autoProbed && members.value.some((agent) => !agent.health || agent.health === 'unknown')) {
    autoProbed = true
    void store.probeAll()
  }
  scrollToBottom()
})
onUnmounted(() => { if (ticker) clearInterval(ticker) })
</script>

<template>
  <div class="grid grid-cols-5 gap-4 h-[calc(100vh-120px)] min-h-0">
    <div class="panel col-span-3 flex flex-col overflow-hidden min-h-0">
      <div class="px-5 py-3.5 border-b border-slate-200 flex items-center gap-3">
        <span class="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">👥</span>
        <div class="flex-1 min-w-0">
          <div class="font-semibold flex items-center gap-2">
            {{ store.currentTeam?.name ?? '项目群聊' }}
            <span class="badge badge-neutral">群主：你</span>
          </div>
          <div class="text-[11px] text-slate-400 mono truncate">{{ store.currentTeam?.defaultWorkspace || '未绑定项目文件夹' }}</div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-slate-500">{{ readyCount }}/{{ members.length }} 可用</span>
          <button class="btn !py-1.5 !px-3" :disabled="store.probing" @click="store.probeAll()">
            <span v-if="store.probing" class="w-3 h-3 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin"></span>
            {{ store.probing ? '体检中…' : '全群体检' }}
          </button>
        </div>
      </div>

      <div ref="scroller" class="flex-1 overflow-auto scroll-thin p-5 space-y-4 bg-slate-50/60 min-h-0">
        <div v-if="chatRun" class="rounded-xl border px-4 py-3"
          :class="gatePassed ? 'border-emerald-200 bg-emerald-50/70' : chatRun.status === 'running' ? 'border-indigo-200 bg-indigo-50/60' : 'border-rose-200 bg-rose-50/70'">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[12px] font-semibold"
              :class="gatePassed ? 'text-emerald-800' : chatRun.status === 'running' ? 'text-indigo-800' : 'text-rose-800'">
              {{ gatePassed ? '✓ 本轮已交付' : chatRun.status === 'running' ? '本轮协同进行中…' : '✕ 本轮未完成 · 禁止交付' }}
            </span>
            <span class="text-[11px] text-slate-500">{{ chatRun.content.slice(0, 42) }}{{ chatRun.content.length > 42 ? '…' : '' }}</span>
            <span v-if="chatRun.durationMs" class="text-[11px] text-slate-400">{{ Math.round(chatRun.durationMs / 1000) }}s</span>
          </div>
          <div class="flex flex-wrap gap-1.5 mt-2">
            <span v-for="participant in chatRun.participants" :key="participant.agentId"
              class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
              :class="participant.status === 'replied' ? 'border-emerald-200 bg-white text-emerald-700'
                : participant.status === 'failed' ? 'border-rose-200 bg-white text-rose-700'
                : participant.status === 'skipped' ? 'border-slate-200 bg-white text-slate-400'
                : 'border-indigo-200 bg-white text-indigo-700'">
              <span class="w-1.5 h-1.5 rounded-full"
                :class="participant.status === 'replied' ? 'bg-emerald-500' : participant.status === 'failed' ? 'bg-rose-500' : participant.status === 'skipped' ? 'bg-slate-300' : 'bg-indigo-500 animate-pulse'"></span>
              {{ participant.name }}
              <span class="text-slate-400">
                {{ participant.status === 'replied' ? `${Math.round(participant.latencyMs / 1000)}s`
                  : participant.status === 'skipped' ? participant.skipReason || '已跳过'
                  : participant.status === 'failed' ? '失败' : '应答中' }}
              </span>
            </span>
          </div>
          <div v-if="!gatePassed && chatRun.gate.reasons.length" class="mt-2 text-[11px] text-rose-700 space-y-0.5">
            <div v-for="reason in chatRun.gate.reasons" :key="reason">· {{ reason }}</div>
          </div>
        </div>

        <div v-for="message in messages" :key="message.id">
          <div v-if="message.kind === 'deliverable'" class="rounded-xl border border-emerald-200 bg-white overflow-hidden">
            <div class="px-4 py-2.5 bg-emerald-50 border-b border-emerald-100 flex items-center gap-2">
              <span class="text-[12px] font-semibold text-emerald-800">最终交付</span>
              <span class="badge" :class="gatePassed ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'">
                {{ gatePassed ? '已通过门禁' : '未通过门禁 · 仅供审阅' }}
              </span>
              <span class="text-[11px] text-emerald-700/70">{{ displayName(message.fromAgentId) }} · {{ message.createdAt.slice(11, 16) }}</span>
            </div>
            <div class="px-4 py-3 md" v-html="renderMarkdown(message.content)"></div>
          </div>
          <div v-else class="flex gap-3" :class="message.fromAgentId === 'user' ? 'flex-row-reverse' : ''">
            <span class="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] shrink-0 font-semibold"
              :class="message.fromAgentId === 'user' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'">
              {{ message.fromAgentId === 'user' ? '主' : initial(displayName(message.fromAgentId)) }}
            </span>
            <div class="max-w-[76%] min-w-0">
              <div class="text-[11px] text-slate-400 mb-1 flex items-center gap-1.5" :class="message.fromAgentId === 'user' ? 'justify-end' : ''">
                <span class="font-medium text-slate-500">{{ displayName(message.fromAgentId, message.sender) }}</span>
                <span v-if="message.fromAgentId !== 'user'" class="text-slate-300">{{ roleOf(message.fromAgentId) }}</span>
                <span v-if="message.toAgentId" class="text-slate-400">→ {{ displayName(message.toAgentId) }}</span>
                <span>· {{ message.createdAt.slice(11, 16) }}</span>
              </div>
              <div class="rounded-xl px-3 py-2 text-[13px] whitespace-pre-wrap break-words leading-relaxed"
                :class="message.fromAgentId === 'user' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-700'">
                {{ message.content }}
              </div>
              <div v-if="message.summary && message.summary !== message.content" class="text-[10px] text-slate-400 mt-1">{{ message.summary }}</div>
            </div>
          </div>
        </div>

        <div v-for="item in live" :key="item.messageId" class="rounded-xl border bg-white overflow-hidden"
          :class="item.phase === 'failed' ? 'border-rose-200' : item.phase === 'completed' ? 'border-slate-200' : 'border-indigo-200 shadow-[0_0_0_3px_rgba(99,102,241,0.06)]'">
          <div class="px-3.5 py-2.5 flex items-center gap-2 border-b border-slate-100">
            <span class="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-semibold"
              :class="item.synthesis ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600'">{{ initial(item.name) }}</span>
            <div class="min-w-0 flex-1">
              <div class="text-[12px] font-semibold truncate flex items-center gap-1.5">
                {{ item.name }}
                <span class="text-[10px] font-normal text-slate-400">{{ item.role }}</span>
                <span v-if="item.synthesis" class="badge bg-violet-50 text-violet-700">汇总</span>
              </div>
            </div>
            <span class="text-[10px] text-slate-400 mono">{{ elapsed(item.startedAt) }}</span>
            <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold" :class="phaseMeta(item.phase).cls">{{ phaseMeta(item.phase).label }}</span>
          </div>

          <div v-if="item.thought" class="px-3.5 pt-2">
            <button class="text-[10px] text-slate-400 hover:text-indigo-600 flex items-center gap-1" @click="toggleThought(item.messageId)">
              {{ thoughtVisible(item.messageId, item.phase) ? '▾' : '▸' }} 思考过程 · {{ item.thought.length }} 字
            </button>
            <pre v-if="thoughtVisible(item.messageId, item.phase)"
              class="mt-1.5 max-h-36 overflow-auto scroll-thin rounded-lg bg-slate-50 border border-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 whitespace-pre-wrap break-words mono">{{ item.thought }}</pre>
          </div>

          <div v-if="item.tools.length" class="px-3.5 pt-2 flex flex-wrap gap-1.5">
            <span v-for="(tool, index) in item.tools" :key="`${tool.name}-${index}`"
              class="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]"
              :class="tool.status === 'denied' ? 'border-rose-200 text-rose-600 bg-rose-50' : tool.status === 'running' ? 'border-indigo-200 text-indigo-600 bg-indigo-50' : 'border-slate-200 text-slate-500 bg-white'">
              {{ tool.status === 'running' ? '⚙' : tool.status === 'denied' ? '⛔' : '✓' }} {{ tool.name.slice(0, 40) }}
            </span>
          </div>

          <div class="px-3.5 py-2.5">
            <div v-if="item.output" class="text-[13px] leading-relaxed text-slate-700 whitespace-pre-wrap break-words">
              {{ item.output }}<span v-if="item.phase === 'replying' || item.phase === 'synthesis'" class="inline-block w-[6px] h-[13px] bg-indigo-500 align-[-2px] animate-pulse ml-0.5"></span>
            </div>
            <div v-else-if="item.phase !== 'failed'" class="flex items-center gap-1.5 text-[12px] text-slate-400">
              <span class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"></span>
              <span class="w-1.5 h-1.5 rounded-full bg-indigo-300 animate-bounce [animation-delay:120ms]"></span>
              <span class="w-1.5 h-1.5 rounded-full bg-indigo-200 animate-bounce [animation-delay:240ms]"></span>
              正在等待首个输出…
            </div>
            <div v-if="item.error" class="text-[12px] text-rose-600 whitespace-pre-wrap break-words">{{ item.error }}</div>
          </div>
        </div>

        <div v-if="!messages.length && !live.length && !chatRun" class="text-center py-14">
          <div class="text-[13px] text-slate-500 font-medium">群聊已就绪，Agent 会真实应答</div>
          <div class="text-[12px] text-slate-400 mt-1">发送一条指令，每位成员会实时展示思考、工具调用与结论；未通过门禁不会交付。</div>
          <div class="flex flex-wrap justify-center gap-2 mt-4">
            <button v-for="example in ['用三句话介绍这个项目', '帮我审查当前目录的代码结构并给出三条改进建议', '给这个产品写一句 slogan']" :key="example"
              class="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
              @click="useExample(example)">{{ example }}</button>
          </div>
        </div>
      </div>

      <div class="border-t border-slate-200 p-3.5 space-y-2 bg-white">
        <div class="flex gap-2">
          <select v-model="target" class="input !w-40 shrink-0">
            <option value="all">全群协同</option>
            <option v-for="agent in members" :key="agent.id" :value="agent.id">私聊 · {{ agent.name }}</option>
          </select>
          <textarea v-model="text" rows="2" class="input resize-none" placeholder="输入任务或指令；Enter 发送，Shift+Enter 换行"
            @keydown.enter.exact.prevent="send"></textarea>
        </div>
        <div class="flex items-center justify-between">
          <div class="text-[11px] text-slate-400">
            <span v-if="isPreviewMode">浏览器预览模式：应答为模拟流</span>
            <span v-else>真实调用本机 Agent · 无额度成员会自动跳过</span>
          </div>
          <div class="flex gap-2">
            <button v-if="runActive" class="btn !text-rose-600 !border-rose-200" @click="store.cancelChat()">停止</button>
            <button class="btn" :disabled="!text.trim() || store.dispatching" @click="sendOnly">仅发消息</button>
            <button class="btn btn-primary" :disabled="!text.trim() || store.dispatching" @click="send">
              <span v-if="store.dispatching" class="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin"></span>
              {{ store.dispatching ? '协同中…' : '协同发送' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="col-span-2 space-y-4 min-h-0 overflow-auto scroll-thin">
      <div class="panel p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-sm font-semibold">群内 Agent <span class="text-slate-400 font-normal">({{ members.length }})</span></h2>
          <span class="text-[11px] text-slate-400">体检后才能保证应答</span>
        </div>
        <div v-for="agent in members" :key="agent.id" class="py-2.5 border-b border-slate-100 last:border-0">
          <div class="flex items-center gap-2.5">
            <span class="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center text-[11px] font-semibold shrink-0">{{ initial(agent.name) }}</span>
            <div class="flex-1 min-w-0">
              <div class="text-[13px] font-medium truncate flex items-center gap-1.5">
                {{ agent.name }}
                <span class="text-[10px] font-normal text-slate-400">{{ roleOf(agent.id) }}</span>
              </div>
              <div class="flex items-center gap-1.5 mt-0.5">
                <span class="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]" :class="healthMeta(agent).cls">
                  <span class="w-1.5 h-1.5 rounded-full" :class="healthMeta(agent).dot"></span>{{ healthMeta(agent).label }}
                </span>
                <span v-if="agent.latencyMs" class="text-[10px] text-slate-400 mono">{{ agent.latencyMs }}ms</span>
                <span v-if="agent.version" class="text-[10px] text-slate-400 truncate max-w-[90px]">{{ agent.version }}</span>
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button class="text-[11px] text-slate-500 hover:text-indigo-600 disabled:opacity-40" :disabled="store.probing" @click="store.probeAgent(agent.id)">体检</button>
              <button class="text-[11px] text-indigo-600" @click="privateChat(agent.id)">私聊</button>
            </div>
          </div>
          <div v-if="agent.health && agent.health !== 'ready' && agent.healthDetail" class="mt-1.5 ml-10 text-[10px] text-slate-400 leading-relaxed line-clamp-2">
            {{ agent.healthDetail }}
          </div>
        </div>
        <div v-if="!members.length" class="text-[12px] text-slate-400 py-3">还没有成员入群，请到「建群与成员」拉 Agent 入群。</div>
      </div>

      <div v-if="chatRun" class="panel p-4">
        <div class="flex items-center justify-between mb-2.5">
          <h2 class="text-sm font-semibold">交付门禁</h2>
          <span class="badge" :class="gatePassed ? 'badge-native' : 'bg-rose-50 text-rose-700'">{{ gatePassed ? 'PASS' : 'BLOCKED' }}</span>
        </div>
        <div class="space-y-1.5">
          <div v-for="check in chatRun.gate.checks" :key="check.key" class="flex items-start gap-2 text-[12px]">
            <span class="mt-0.5 w-4 h-4 rounded-full flex items-center justify-center text-[10px] shrink-0"
              :class="check.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'">{{ check.ok ? '✓' : '✕' }}</span>
            <div class="min-w-0">
              <div :class="check.ok ? 'text-slate-600' : 'text-rose-700 font-medium'">{{ check.label }}</div>
              <div class="text-[10px] text-slate-400 break-words">{{ check.detail }}</div>
            </div>
          </div>
        </div>
        <div v-if="deliverableMessage" class="mt-3 pt-3 border-t border-slate-100 text-[11px] text-slate-500">
          交付物来自 <span class="font-medium text-slate-700">{{ displayName(deliverableMessage.fromAgentId) }}</span> · {{ deliverableMessage.content.length }} 字
        </div>
      </div>

      <div class="panel p-4">
        <h2 class="text-sm font-semibold mb-3">群任务概览</h2>
        <div class="grid grid-cols-4 gap-2 text-center">
          <div v-for="status in ['pending','running','review','done']" :key="status" class="rounded-lg bg-slate-50 py-2">
            <div class="text-lg font-bold">{{ store.teamTasks.filter((task) => status === 'review' ? task.boardColumn === 'review' : status === 'done' ? task.status === 'completed' : task.status === status).length }}</div>
            <div class="text-[10px] text-slate-400">{{ ({ pending: '待办', running: '进行中', review: '审查中', done: '完成' } as Record<string, string>)[status] }}</div>
          </div>
        </div>
        <RouterLink to="/tasks" class="btn w-full mt-3 !text-[12px]">查看任务详情 →</RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.md :deep(h3) { font-size: 14px; font-weight: 700; color: #0f172a; margin: 10px 0 4px; }
.md :deep(h4) { font-size: 13px; font-weight: 700; color: #1e293b; margin: 8px 0 3px; }
.md :deep(h5), .md :deep(h6) { font-size: 12px; font-weight: 600; color: #334155; margin: 6px 0 2px; }
.md :deep(p) { font-size: 13px; color: #334155; line-height: 1.7; margin: 2px 0; }
.md :deep(ul) { margin: 4px 0; padding-left: 18px; list-style: disc; }
.md :deep(li) { font-size: 13px; color: #334155; line-height: 1.7; }
.md :deep(strong) { font-weight: 700; color: #0f172a; }
.md :deep(code) { font-family: "Cascadia Code", Consolas, monospace; font-size: 12px; background: #f1f5f9; padding: 1px 4px; border-radius: 4px; color: #4338ca; }
</style>
