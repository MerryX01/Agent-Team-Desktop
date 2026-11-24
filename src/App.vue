<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useAppStore } from './stores/app'
import { isPreviewMode } from './api'

const store = useAppStore()
let unsubscribe: (() => void) | undefined

onMounted(async () => {
  await store.refresh()
  unsubscribe = store.subscribeEvents()
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div class="flex h-screen bg-slate-50 text-slate-800">
    <aside class="w-60 shrink-0 border-r border-slate-200 bg-white flex flex-col">
      <div class="px-5 py-5 border-b border-slate-200">
        <div class="text-[15px] font-bold tracking-tight text-slate-900">Agent Team</div>
        <div class="text-[11px] text-slate-500 mt-0.5">本机团队协作台 · v0.1</div>
      </div>
      <nav class="p-3 space-y-1 flex-1">
        <RouterLink v-for="item in [
          { to: '/', label: '工作台', icon: '⌂' },
          { to: '/agents', label: 'Agent 管理', icon: '◈' },
          { to: '/providers', label: 'API 模型', icon: '◇' },
          { to: '/teams', label: '团队编排', icon: '▤' },
          { to: '/tasks', label: '任务执行', icon: '▶' },
          { to: '/settings', label: '设置', icon: '⚙' }
        ]" :key="item.to" :to="item.to"
          class="flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] text-slate-600 hover:bg-slate-100"
          active-class="!bg-indigo-50 !text-indigo-700 !font-semibold">
          <span class="w-5 text-center text-base">{{ item.icon }}</span>{{ item.label }}
        </RouterLink>
      </nav>
      <div class="p-4 border-t border-slate-200 text-[11px] text-slate-500 leading-relaxed">
        <div v-if="isPreviewMode" class="badge badge-warn mb-2">浏览器预览模式</div>
        <div>原生 Agent 走本机 CLI 登录态；API Key 通道独立。</div>
      </div>
    </aside>

    <main class="flex-1 min-w-0 flex flex-col">
      <header class="h-14 shrink-0 bg-white border-b border-slate-200 px-6 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span class="text-[13px] text-slate-500">当前团队</span>
          <select v-model="store.currentTeamId" class="input !w-52" @change="store.refresh()">
            <option v-for="team in store.teams" :key="team.id" :value="team.id">{{ team.name }}</option>
          </select>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-[12px] text-slate-500">{{ store.agents.filter(a => a.installed).length }} 个本机 Agent 已安装</span>
          <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
        </div>
      </header>
      <div v-if="store.notice" class="mx-6 mt-4 px-4 py-2 rounded-lg bg-indigo-50 text-indigo-700 text-[12px] flex justify-between items-center">
        <span>{{ store.notice }}</span>
        <button class="text-indigo-400 hover:text-indigo-700" @click="store.notice = ''">✕</button>
      </div>
      <section class="flex-1 overflow-auto scroll-thin p-6">
        <RouterView />
      </section>
    </main>
  </div>
</template>
