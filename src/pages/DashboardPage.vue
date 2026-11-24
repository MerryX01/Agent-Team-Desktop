<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app'

const store = useAppStore()
const router = useRouter()
const stats = computed(() => [
  { label: '团队 Agent', value: store.agents.length, hint: '含待验证成员' },
  { label: '本机已安装', value: store.agents.filter((a) => a.installed).length, hint: '来自 where.exe 检测' },
  { label: 'API 模型', value: store.providers.length, hint: '独立 Key 通道' },
  { label: '任务总数', value: store.teamTasks.length, hint: `运行中 ${store.teamTasks.filter((t) => t.status === 'running').length}` }
])
</script>

<template>
  <div class="space-y-5">
    <div>
      <h1 class="text-xl font-bold text-slate-900">工作台</h1>
      <p class="text-[13px] text-slate-500 mt-1">本机原生 Agent 与 API Key 模型统一管理，任务状态实时汇总。</p>
    </div>

    <div class="grid grid-cols-4 gap-4">
      <div v-for="item in stats" :key="item.label" class="panel p-4">
        <div class="text-[12px] text-slate-500">{{ item.label }}</div>
        <div class="text-2xl font-bold mt-1 text-slate-900">{{ item.value }}</div>
        <div class="text-[11px] text-slate-400 mt-1">{{ item.hint }}</div>
      </div>
    </div>

    <div class="grid grid-cols-3 gap-4">
      <div class="panel p-5 col-span-2">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-semibold">团队成员</h2>
          <RouterLink to="/agents" class="text-[12px] text-indigo-600">管理 →</RouterLink>
        </div>
        <div class="space-y-2">
          <div v-for="agent in store.agents" :key="agent.id" class="flex items-center gap-3 p-3 rounded-lg border border-slate-100 hover:border-slate-200">
            <div class="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-sm">{{ agent.name.slice(0, 1) }}</div>
            <div class="flex-1 min-w-0">
              <div class="text-[13px] font-medium">{{ agent.name }}</div>
              <div class="text-[11px] text-slate-500 truncate">{{ agent.note || agent.vendor }}</div>
            </div>
            <span v-if="agent.authMode === 'native-login'" class="badge badge-native">本机账号</span>
            <span v-else-if="agent.authMode === 'api-key'" class="badge badge-api">API Key</span>
            <span v-else class="badge badge-warn">待验证</span>
            <span class="text-[11px] text-slate-400 w-20 text-right">{{ agent.installed ? '已安装' : '未安装' }}</span>
          </div>
        </div>
      </div>

      <div class="panel p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-semibold">最近事件</h2>
          <button class="text-[12px] text-slate-400 hover:text-slate-700" @click="store.clearEvents()">清空</button>
        </div>
        <div class="space-y-3 max-h-80 overflow-auto scroll-thin">
          <div v-for="event in store.events.slice(0, 12)" :key="event.id" class="text-[12px]">
            <div class="flex items-center gap-2">
              <span class="w-1.5 h-1.5 rounded-full" :class="event.type.includes('failed') ? 'bg-rose-500' : event.type.includes('completed') ? 'bg-emerald-500' : 'bg-indigo-400'"></span>
              <span class="text-slate-700 truncate">{{ event.message }}</span>
            </div>
            <div class="text-[10px] text-slate-400 ml-3.5">{{ event.timestamp.slice(11, 19) }}</div>
          </div>
          <div v-if="!store.events.length" class="text-[12px] text-slate-400">暂无事件。去任务执行页启动一次运行。</div>
        </div>
        <button class="btn btn-primary w-full mt-4" @click="router.push('/tasks')">执行任务</button>
      </div>
    </div>
  </div>
</template>
