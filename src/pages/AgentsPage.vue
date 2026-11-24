<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAppStore } from '../stores/app'
import { api, isPreviewMode } from '../api'
import RolePicker from '../components/RolePicker.vue'
import { ROLE_CATALOG } from '@shared/index'
import type { AgentDefinition } from '@shared/index'
import { newId } from '@shared/index'

const store = useAppStore()
const selectedId = ref<string | null>(null)
const draft = ref<AgentDefinition | null>(null)
const statusText = ref('')
const argsText = ref('')
const statusArgsText = ref('')
const headlessArgsText = ref('')
const remoteTokenText = ref('')
const checking = ref(false)

const selected = computed(() => store.agents.find((a) => a.id === selectedId.value))

function edit(agent: AgentDefinition) {
  selectedId.value = agent.id
  draft.value = JSON.parse(JSON.stringify(agent)) as AgentDefinition
  argsText.value = (agent.args ?? []).join(' ')
  statusArgsText.value = (agent.statusArgs ?? []).join(' ')
  headlessArgsText.value = (agent.headlessArgs ?? []).join(' ')
  remoteTokenText.value = ''
  statusText.value = ''
}

async function detect() {
  if (!draft.value) return
  checking.value = true
  try {
    const result = await store.detectAgent(draft.value.id)
    statusText.value = result.installed
      ? `已安装：${result.commandPath ?? draft.value.command}${result.version ? ' · ' + result.version : ''}`
      : `未安装：${result.detail ?? '未知原因'}`
  } finally { checking.value = false }
}

async function checkLogin() {
  if (!draft.value) return
  checking.value = true
  try {
    const result = await store.checkLogin(draft.value.id)
    statusText.value = `${result.state}: ${result.detail}`
  } finally { checking.value = false }
}

async function save() {
  if (!draft.value) return
  draft.value.args = argsText.value.split(/\s+/).filter(Boolean)
  draft.value.statusArgs = statusArgsText.value.trim() ? statusArgsText.value.split(/\s+/).filter(Boolean) : undefined
  draft.value.headlessArgs = headlessArgsText.value.split(/\s+/).filter(Boolean)
  if (draft.value.kind === 'remote-acp' && remoteTokenText.value) {
    draft.value.remoteTokenRef = await api.credentials.set(remoteTokenText.value, draft.value.remoteTokenRef)
    remoteTokenText.value = ''
  }
  await store.saveAgent(draft.value)
  statusText.value = '配置已保存（密钥仅保存引用）'
}

async function addCustomAgent() {
  const adapter = store.customAdapters.find((item) => item.enabled)
  if (!adapter) { statusText.value = '请先在设置页添加自定义 CLI Adapter'; return }
  const agent: AgentDefinition = {
    id: newId('agent'), name: adapter.name, kind: 'native-process', vendor: 'Custom CLI',
    command: adapter.command, args: [...adapter.args], env: { ...adapter.env },
    headlessArgs: [...adapter.args], headlessFallback: true, usageSupported: false, workflow: '', isLead: false, enabled: true, authMode: 'native-login', role: 'developer',
    installed: false, note: adapter.note ?? '自定义 CLI Adapter', customAdapterRef: adapter.id
  }
  await store.saveAgent(agent)
  edit(agent)
}

async function detectAll() {
  if (isPreviewMode) {
    statusText.value = '当前是浏览器预览模式：不会启动本机 CLI，检测始终显示未安装。请在桌面端（npm run dev 或已打包应用）点击批量检测。'
    return
  }
  checking.value = true
  try {
    const result = await api.agents.detectAll()
    await store.refresh()
    const installed = Object.values(result).filter((item) => item.installed).length
    statusText.value = `检测完成：${installed} 个已安装；未安装的 Agent 可在上方指定绝对路径后重试`
  } finally { checking.value = false }
}

async function removeAgent(agent: AgentDefinition) {
  if (!window.confirm(`确定删除成员「${agent.name}」？该操作同时从团队中移除该成员。`)) return
  await store.removeAgent(agent.id)
  if (selectedId.value === agent.id) { selectedId.value = null; draft.value = null }
}

async function addApiAgent() {
  const agent: AgentDefinition = {
    id: newId('agent'), name: '新 API 模型成员', kind: 'api-provider', vendor: 'Custom',
    command: '', args: [], env: {}, headlessArgs: [], headlessFallback: false, usageSupported: false, workflow: '', isLead: false,
    enabled: true, authMode: 'api-key', role: 'developer',
    installed: true, note: '使用 API Key 通道，费用自行承担', providerRef: store.providers[0]?.id
  }
  await store.saveAgent(agent)
  edit(agent)
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-end justify-between">
      <div>
        <h1 class="text-xl font-bold text-slate-900">Agent 管理</h1>
        <p class="text-[13px] text-slate-500 mt-1">仅通过官方 CLI / ACP / SDK 接入；原生登录与 API Key 严格分离。</p>
      </div>
      <div class="flex gap-2">
        <button class="btn" :disabled="checking" @click="detectAll">批量检测</button>
        <button class="btn" @click="store.refreshPaths()">刷新 PATH</button>
        <button class="btn" @click="addCustomAgent">+ 自定义 CLI 成员</button>
        <button class="btn" @click="addApiAgent">+ API Key 成员</button>
      </div>
    </div>

    <div v-if="isPreviewMode" class="rounded-lg bg-amber-50 border border-amber-200 px-4 py-2 text-[12px] text-amber-700">
      当前是浏览器预览模式，批量检测不会读取本机 CLI。请在桌面端运行应用后检测；本机已安装的 OpenCode 会在桌面端显示为已安装。
    </div>
    <div v-if="statusText && !isPreviewMode" class="rounded-lg bg-indigo-50 border border-indigo-200 px-4 py-2 text-[12px] text-indigo-700">
      {{ statusText }}
    </div>

    <div class="grid grid-cols-5 gap-4">
      <div class="panel col-span-3 overflow-hidden">
        <table class="table">
          <thead><tr><th>Agent</th><th>来源</th><th>命令</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="agent in store.agents" :key="agent.id" :class="selectedId === agent.id ? 'bg-indigo-50/60' : ''" @click="edit(agent)" class="cursor-pointer">
              <td>
                <div class="font-medium">{{ agent.name }}</div>
                <div class="text-[11px] text-slate-400">{{ agent.vendor }}</div>
              </td>
              <td>
                <span v-if="agent.authMode === 'native-login'" class="badge badge-native">本机账号</span>
                <span v-else-if="agent.authMode === 'api-key'" class="badge badge-api">API Key</span>
                <span v-else class="badge badge-warn">待验证</span>
              </td>
              <td class="mono text-[11px] text-slate-500">{{ agent.command || '—' }}</td>
              <td>
                <span v-if="agent.kind === 'api-provider'" class="badge badge-api">已配置</span>
                <span v-else-if="agent.installed" class="badge badge-native">已安装</span>
                <span v-else class="badge badge-neutral">未安装</span>
              </td>
              <td>
                <div class="flex gap-2" @click.stop>
                  <button class="text-[12px] text-indigo-600" @click="edit(agent)">编辑</button>
                  <button class="text-[12px] text-slate-400 hover:text-rose-600" @click="removeAgent(agent)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="draft" class="panel col-span-2 p-5 space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">配置 · {{ draft.name }}</h2>
          <label class="text-[12px] text-slate-500 flex items-center gap-1">
            <input v-model="draft.enabled" type="checkbox" /> 启用
          </label>
        </div>

        <div>
          <label class="label">显示名称</label>
          <input v-model="draft.name" class="input" />
        </div>
        <template v-if="draft.kind !== 'api-provider'">
          <div>
            <label class="label">启动命令（可填绝对路径，兼容 .cmd / .exe）</label>
            <input v-model="draft.command" class="input mono" :disabled="draft.kind === 'remote-acp'" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="label">ACP 参数（空格分隔）</label>
              <input v-model="argsText" class="input mono" />
            </div>
            <div>
              <label class="label">登录状态命令参数</label>
              <input v-model="statusArgsText" class="input mono" placeholder="留空=未提供官方命令" />
            </div>
          </div>
        </template>
        <template v-if="draft.kind === 'native-acp' || draft.kind === 'native-process'">
          <div class="rounded-lg border border-slate-200 p-3 space-y-2">
            <div class="text-[12px] font-semibold text-slate-600">Headless 后备通道</div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="label">无头命令</label>
                <input v-model="draft.headlessCommand" class="input mono" placeholder="如 qwen / mcode exec" />
              </div>
              <div>
                <label class="label">无头参数</label>
                <input v-model="headlessArgsText" class="input mono" placeholder="-p" />
              </div>
            </div>
            <label class="text-[12px] text-slate-500 flex items-center gap-1">
              <input v-model="draft.headlessFallback" type="checkbox" /> ACP 连接失败时回退到无头进程
            </label>
          </div>
        </template>
        <template v-if="draft.kind === 'remote-acp'">
          <div class="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
            <div class="text-[12px] font-semibold text-amber-700">企业远程 ACP（不等于本机桌面额度）</div>
            <div><label class="label">远程 ACP 地址</label><input v-model="draft.remoteUrl" class="input mono" /></div>
            <div><label class="label">Access Token（仅保存凭据引用）</label><input v-model="remoteTokenText" type="password" class="input mono" placeholder="留空表示沿用已保存凭据" /></div>
          </div>
        </template>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label">角色（可搜索预设或自定义）</label>
            <RolePicker v-model="draft.role" />
            <p class="text-[10px] text-slate-400 mt-1">
              {{ ROLE_CATALOG.find((item) => item.value === draft!.role)?.description ?? '角色职责提示词会注入成员任务简报' }}
            </p>
          </div>
          <div v-if="draft.kind === 'api-provider'">
            <label class="label">API Provider</label>
            <select v-model="draft.providerRef" class="input">
              <option v-for="provider in store.providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
            </select>
          </div>
        </div>
        <div>
          <label class="label">工作流 / 角色指令（注入成员简报）</label>
          <textarea v-model="draft.workflow" class="input" rows="2" placeholder="例如：只审查 Diff，不修改文件；输出问题按严重度排序"></textarea>
        </div>
        <label class="text-[12px] text-slate-500 flex items-center gap-1">
          <input v-model="draft.isLead" type="checkbox" /> 保留为协调 Lead（姓名与角色不对外伪装）
        </label>
        <div>
          <label class="label">说明 / 接入提示</label>
          <textarea v-model="draft.note" class="input" rows="2"></textarea>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary" :disabled="checking" @click="save">保存配置</button>
          <button v-if="draft.kind !== 'api-provider'" class="btn" :disabled="checking" @click="detect">检测命令</button>
          <button v-if="draft.authMode === 'native-login'" class="btn" :disabled="checking" @click="checkLogin">检查登录状态</button>
        </div>
        <p class="text-[11px] text-slate-400 leading-relaxed">不复制第三方 Token；登录失效时请在原 CLI 登录。额度与订阅由原厂账号决定，平台不承诺免费。</p>
      </div>
    </div>
  </div>
</template>
