<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import { newId } from '@shared/index'
import type { CustomAdapter } from '@shared/index'

const store = useAppStore()
const workspacePath = ref('')
const workspaces = ref<Array<{ id: string; path: string; isolation: string }>>([])
const memory = ref({ key: '', value: '', scope: 'team' as 'team' | 'agent' | 'project', scopeId: '' })
const custom = ref<CustomAdapter>({
  id: '', name: '', command: '', args: [], protocol: 'jsonl', env: {}, promptFlag: '', enabled: true, note: ''
})
const customArgsText = ref('')

onMounted(async () => { workspaces.value = await api.workspaces.list() })

async function save() {
  await store.saveSettings({
    defaultWorkspace: store.settings.defaultWorkspace ?? '',
    permissionMode: store.settings.permissionMode ?? 'ask',
    logRetentionDays: store.settings.logRetentionDays ?? 30
  })
}

async function addWorkspace() {
  if (!workspacePath.value.trim()) return
  await api.workspaces.add(workspacePath.value.trim())
  workspaces.value = await api.workspaces.list()
  workspacePath.value = ''
}

async function addMemory() {
  if (!memory.value.key || !memory.value.value) return
  await store.saveMemory(memory.value.scope, memory.value.scopeId || store.currentTeamId, memory.value.key, memory.value.value)
  memory.value.key = ''
  memory.value.value = ''
}

async function saveCustom() {
  await store.saveCustomAdapter({ ...custom.value, args: customArgsText.value.split(/\s+/).filter(Boolean), id: custom.value.id || newId('adapter') })
  custom.value = { id: '', name: '', command: '', args: [], protocol: 'jsonl', env: {}, promptFlag: '', enabled: true, note: '' }
  customArgsText.value = ''
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h1 class="text-xl font-bold text-slate-900">设置</h1>
      <p class="text-[13px] text-slate-500 mt-1">工作目录、权限边界、长期记忆、自定义 Adapter 与仅来自官方的用量数据。</p>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div class="panel p-5 space-y-4">
        <h2 class="text-sm font-semibold">运行设置</h2>
        <div>
          <label class="label">默认工作目录</label>
          <input v-model="store.settings.defaultWorkspace" class="input mono" placeholder="D:\\projects\\demo" />
        </div>
        <div>
          <label class="label">权限模式</label>
          <select v-model="store.settings.permissionMode" class="input">
            <option value="ask">高风险操作前询问</option>
            <option value="auto-deny">自动拒绝</option>
            <option value="plan">仅规划，不执行</option>
          </select>
        </div>
        <div>
          <label class="label">日志保留天数</label>
          <input v-model.number="store.settings.logRetentionDays" type="number" min="1" class="input" />
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary" @click="save">保存设置</button>
          <button class="btn" @click="store.refreshPaths()">刷新 PATH</button>
        </div>
      </div>

      <div class="panel p-5">
        <h2 class="text-sm font-semibold mb-4">工作目录白名单</h2>
        <div class="flex gap-2 mb-4">
          <input v-model="workspacePath" class="input mono" placeholder="选择或粘贴绝对路径" />
          <button class="btn shrink-0 whitespace-nowrap" @click="addWorkspace">添加</button>
        </div>
        <div v-for="workspace in workspaces" :key="workspace.id" class="text-[12px] mono text-slate-600 border-b border-slate-100 py-2">
          {{ workspace.path }}
        </div>
        <div v-if="!workspaces.length" class="text-[12px] text-slate-400">未添加工作目录；Agent 默认只能在团队工作目录内读写。</div>
        <p class="text-[11px] text-slate-400 mt-4 leading-relaxed">
          平台不读取第三方客户端私有 Token 数据库；API Key 仅以系统凭据引用保存。日志默认脱敏 Key、Authorization 与账号标识。
        </p>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div class="panel p-5">
        <h2 class="text-sm font-semibold mb-4">长期记忆</h2>
        <div class="grid grid-cols-3 gap-2 mb-2">
          <select v-model="memory.scope" class="input"><option value="team">团队</option><option value="agent">Agent</option><option value="project">项目</option></select>
          <input v-model="memory.scopeId" class="input mono" :placeholder="store.currentTeamId" />
          <input v-model="memory.key" class="input" placeholder="键" />
        </div>
        <textarea v-model="memory.value" class="input" rows="2" placeholder="只写入明确、可验证的摘要"></textarea>
        <button class="btn btn-primary mt-2" @click="addMemory">保存记忆</button>
        <div class="mt-4 max-h-56 overflow-auto scroll-thin">
          <div v-for="item in store.memory" :key="item.id" class="flex gap-2 border-b border-slate-100 py-2 text-[12px]">
            <div class="flex-1 min-w-0">
              <div class="font-medium">{{ item.key }} <span class="text-slate-400">· {{ item.scope }}/{{ item.scopeId }}</span></div>
              <div class="text-slate-500 break-all">{{ item.value }}</div>
            </div>
            <button class="text-slate-400 hover:text-rose-600" @click="store.removeMemory(item.id)">删除</button>
          </div>
          <div v-if="!store.memory.length" class="text-slate-400">暂无记忆条目</div>
        </div>
      </div>

      <div class="panel p-5">
        <h2 class="text-sm font-semibold mb-4">用量（仅官方返回）</h2>
        <div v-for="item in store.usage" :key="item.id" class="border-b border-slate-100 py-2 text-[12px]">
          <div class="font-medium">{{ store.agentById(item.agentId)?.name ?? item.agentId }}</div>
          <div class="text-slate-500">
            输入 {{ item.inputTokens ?? '未提供' }} · 输出 {{ item.outputTokens ?? '未提供' }} · 费用 {{ item.cost ?? '未提供' }}
          </div>
          <div class="text-[11px] text-slate-400">{{ item.source }} · {{ item.createdAt.slice(11, 19) }}</div>
        </div>
        <div v-if="!store.usage.length" class="text-[12px] text-slate-400 leading-relaxed">
          额度由官方客户端管理，未获取到官方返回的用量数据，不在此处猜测额度。
        </div>
      </div>
    </div>

    <div class="panel p-5">
      <h2 class="text-sm font-semibold mb-4">自定义 CLI Adapter</h2>
      <div class="grid grid-cols-6 gap-2 mb-3">
        <input v-model="custom.name" class="input" placeholder="名称" />
        <input v-model="custom.command" class="input mono" placeholder="命令" />
        <input v-model="customArgsText" class="input mono" placeholder="参数（空格分隔）" />
        <select v-model="custom.protocol" class="input"><option value="jsonl">JSONL</option><option value="plain">纯文本</option><option value="acp">ACP</option></select>
        <input v-model="custom.promptFlag" class="input mono" placeholder="prompt 参数" />
        <button class="btn btn-primary" @click="saveCustom">保存 Adapter</button>
      </div>
      <div v-for="adapter in store.customAdapters" :key="adapter.id" class="flex items-center gap-3 border-b border-slate-100 py-2 text-[12px]">
        <span class="font-medium">{{ adapter.name }}</span>
        <span class="mono text-slate-500">{{ adapter.command }} {{ adapter.args.join(' ') }}</span>
        <span class="badge badge-neutral">{{ adapter.protocol }}</span>
        <button class="ml-auto text-slate-400 hover:text-rose-600" @click="store.removeCustomAdapter(adapter.id)">删除</button>
      </div>
      <div v-if="!store.customAdapters.length" class="text-[12px] text-slate-400">暂无自定义 Adapter；保存后可在 Agent 管理页添加为成员。</div>
    </div>
  </div>
</template>
