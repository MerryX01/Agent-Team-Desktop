<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  MODEL_CATALOG, MODEL_TOOL_LABEL, modelRateText, modelToolForAgent,
  type ModelEntry, type ModelTool
} from '@shared/index'
import { useAppStore } from '../stores/app'

const store = useAppStore()
const tool = ref<ModelTool | 'all'>('all')
const freeOnly = ref(false)
const query = ref('')
const selectedId = ref<string | null>(null)

const tools = Object.keys(MODEL_TOOL_LABEL) as ModelTool[]

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return MODEL_CATALOG.filter((entry) => {
    if (tool.value !== 'all' && entry.tool !== tool.value) return false
    if (freeOnly.value && !entry.free) return false
    if (q && ![entry.label, entry.modelId, entry.family, entry.id].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
})

const selected = computed(() => MODEL_CATALOG.find((entry) => entry.id === selectedId.value))

const selectedAgent = computed(() => (selected.value ? store.agents.find((a) => modelToolForAgent(a.id) === selected.value!.tool) : undefined))

function rateClass(entry: ModelEntry): string {
  if (entry.free) return 'badge-native'
  if (entry.creditRate !== undefined) return 'badge-api'
  if (entry.priceInput !== undefined) return 'badge-warn'
  return 'badge-neutral'
}

function applyToAgent(entry: ModelEntry) {
  const agent = selectedAgent.value
  if (!agent) return
  agent.modelRef = entry.id
  void store.saveAgent({ ...agent })
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h1 class="text-xl font-bold text-slate-900">模型映射目录</h1>
      <p class="text-[13px] text-slate-500 mt-1">
        各工具官方模型的可选清单与计费口径。免费与倍率均来自官方文档；官方未公开的一律标注「未公开」，不使用第三方中转倍率。
      </p>
    </div>

    <div class="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-[12px] text-amber-800 leading-relaxed">
      <div class="font-semibold mb-1">倍率口径（务必先读）</div>
      <div>OpenCode / Trae：官方只公布刊列价（USD / 1M token），没有「倍率」概念，本表直接展示输入输出价；免费模型标 0x。</div>
      <div>Qoder：官方用 Credits 消耗倍率，仅个别模型公开（如 Qwen3.8-Flash 限时 0.0x）；其余标注「未公开」，以产品内模型选择器为准。</div>
      <div>Claude Code / Codex CLI：走本机订阅登录态，工具本身不公开倍率，费用由原厂账号决定。</div>
      <div class="mt-1">限时免费与地区限制会变动，点击来源链接以官方文档为最终依据。</div>
    </div>

    <div class="panel p-4 flex flex-wrap items-center gap-3">
      <select v-model="tool" class="input !w-40">
        <option value="all">全部工具</option>
        <option v-for="t in tools" :key="t" :value="t">{{ MODEL_TOOL_LABEL[t] }}</option>
      </select>
      <input v-model="query" class="input !w-64" placeholder="搜索模型名称 / ID / 厂商" />
      <label class="text-[12px] text-slate-600 flex items-center gap-1">
        <input v-model="freeOnly" type="checkbox" /> 仅看免费
      </label>
      <span class="text-[12px] text-slate-400 ml-auto">共 {{ filtered.length }} 个模型（官方公开条目）</span>
    </div>

    <div class="grid grid-cols-5 gap-4">
      <div class="panel col-span-3 overflow-hidden">
        <table class="table">
          <thead>
            <tr><th>工具 / 模型</th><th>模型 ID</th><th>免费 / 倍率或刊列价</th><th>来源</th></tr>
          </thead>
          <tbody>
            <tr v-for="entry in filtered" :key="entry.id" :class="selectedId === entry.id ? 'bg-indigo-50/60' : ''" class="cursor-pointer" @click="selectedId = entry.id">
              <td>
                <div class="font-medium">{{ entry.label }}</div>
                <div class="text-[11px] text-slate-400">{{ MODEL_TOOL_LABEL[entry.tool] }} · {{ entry.family || '—' }}</div>
              </td>
              <td class="mono text-[11px] text-slate-500 break-all">{{ entry.modelId }}</td>
              <td><span class="badge" :class="rateClass(entry)">{{ modelRateText(entry) }}</span></td>
              <td><a :href="entry.source" target="_blank" rel="noreferrer" class="text-[11px] text-indigo-600 hover:underline" @click.stop>官方 ↗</a></td>
            </tr>
            <tr v-if="!filtered.length"><td colspan="4" class="text-center text-slate-400 py-10">没有匹配的官方模型条目</td></tr>
          </tbody>
        </table>
      </div>

      <div class="col-span-2">
        <div v-if="selected" class="panel p-5 space-y-3">
          <h2 class="text-sm font-semibold">模型详情 · {{ selected.label }}</h2>
          <div class="grid grid-cols-2 gap-3 text-[12px]">
            <div><div class="text-slate-400">所属工具</div><div class="font-medium">{{ MODEL_TOOL_LABEL[selected.tool] }}</div></div>
            <div><div class="text-slate-400">厂商 / 家族</div><div class="font-medium">{{ selected.family || '—' }}</div></div>
            <div><div class="text-slate-400">官方模型 ID</div><div class="mono break-all">{{ selected.modelId }}</div></div>
            <div><div class="text-slate-400">计费口径</div><div class="font-medium">{{ modelRateText(selected) }}</div></div>
            <div v-if="selected.priceInput !== undefined"><div class="text-slate-400">输入价 / 1M</div><div>${{ selected.priceInput }}</div></div>
            <div v-if="selected.priceOutput !== undefined"><div class="text-slate-400">输出价 / 1M</div><div>${{ selected.priceOutput }}</div></div>
            <div v-if="selected.creditRate !== undefined"><div class="text-slate-400">Credits 倍率</div><div>{{ selected.creditRate }}x</div></div>
          </div>
          <div class="rounded-lg bg-slate-50 border border-slate-200 p-3 text-[12px] text-slate-600 leading-relaxed">{{ selected.note || '官方未提供额外说明。' }}</div>
          <div>
            <label class="label">应用到成员（该工具的 Agent）</label>
            <select v-if="selectedAgent" :value="selectedAgent.modelRef === selected.id ? selected.id : ''" class="input" @change="applyToAgent(selected)">
              <option value="">选择以应用此模型</option>
              <option :value="selected.id">{{ selectedAgent.name }} → {{ selected.label }}</option>
            </select>
            <div v-else class="text-[12px] text-slate-400">该工具没有可调度 CLI 成员（请先在 Agent 管理页安装/配置对应 CLI）。</div>
          </div>
          <p class="text-[11px] text-slate-400 leading-relaxed">
            选择仅写入成员配置作为模型映射记录；OpenCode ACP 通过会话 set_model 尽力应用，Claude/Codex 通过 --model 应用，是否生效以工具自身为准。
          </p>
        </div>
        <div v-else class="panel p-5 text-[13px] text-slate-400 text-center py-16">从左侧选择一个模型查看详情</div>
      </div>
    </div>
  </div>
</template>
