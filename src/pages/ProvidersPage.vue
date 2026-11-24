<script setup lang="ts">
import { ref } from 'vue'
import { useAppStore } from '../stores/app'
import { api } from '../api'
import { newId } from '@shared/index'
import type { ApiProvider } from '@shared/index'

const store = useAppStore()
const form = ref({
  id: '', name: '', protocol: 'openai-compatible' as ApiProvider['protocol'],
  baseUrl: '', model: '', apiKey: '', contextLength: 8192, maxOutput: 2048, timeoutMs: 60000
})
const result = ref('')
const testing = ref(false)
const models = ref<string[]>([])

function editProvider(provider: ApiProvider & { hasKey?: boolean }) {
  form.value = {
    id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl,
    model: provider.model, apiKey: '', contextLength: provider.contextLength,
    maxOutput: provider.maxOutput, timeoutMs: provider.timeoutMs
  }
  models.value = provider.models ?? []
  result.value = ''
}

function reset() {
  form.value = {
    id: '', name: '', protocol: 'openai-compatible', baseUrl: '', model: '',
    apiKey: '', contextLength: 8192, maxOutput: 2048, timeoutMs: 60000
  }
  result.value = ''
}

async function save() {
  const provider: Partial<ApiProvider> = {
    id: form.value.id || newId('provider'),
    name: form.value.name || '未命名 Provider',
    protocol: form.value.protocol,
    baseUrl: form.value.baseUrl.replace(/\/$/, ''),
    model: form.value.model,
    credentialRef: newId('cred'),
    contextLength: form.value.contextLength,
    maxOutput: form.value.maxOutput,
    timeoutMs: form.value.timeoutMs,
    verified: false,
    models: models.value
  }
  await store.saveProvider(provider, form.value.apiKey || undefined)
  form.value.id = provider.id!
  form.value.apiKey = ''
  result.value = '已保存。连接测试成功前不会标记为已验证。'
}

async function fetchModels() {
  if (!form.value.id) { result.value = '请先保存 Provider'; return }
  testing.value = true
  try {
    models.value = await api.providers.models(form.value.id, form.value.apiKey || undefined)
    result.value = models.value.length ? `获取到 ${models.value.length} 个模型` : '未获取到模型列表，请手动填写模型 ID'
  } finally { testing.value = false }
}

async function test() {
  if (!form.value.id) { result.value = '请先保存 Provider'; return }
  testing.value = true
  try {
    const response = await store.testProvider(form.value.id, form.value.apiKey || undefined)
    result.value = response.ok ? `连接成功：${response.detail}` : `连接失败：${response.detail}`
  } finally { testing.value = false }
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h1 class="text-xl font-bold text-slate-900">API 模型管理</h1>
      <p class="text-[13px] text-slate-500 mt-1">独立 API Key 通道，不作为本机 CLI 登录的替代路径；密钥经系统凭据保护。</p>
    </div>

    <div class="grid grid-cols-5 gap-4">
      <div class="panel col-span-3 p-5">
        <h2 class="text-sm font-semibold mb-4">已配置 Provider</h2>
        <div v-if="!store.providers.length" class="text-[13px] text-slate-400 py-10 text-center">尚未添加。请在右侧填写 Provider 与模型。</div>
        <div v-for="provider in store.providers" :key="provider.id" class="border border-slate-100 rounded-lg p-3 mb-2 flex items-center gap-3 cursor-pointer hover:border-indigo-200" @click="editProvider(provider)">
          <div class="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">◇</div>
          <div class="flex-1 min-w-0">
            <div class="text-[13px] font-medium">{{ provider.name }}</div>
            <div class="text-[11px] text-slate-400 mono truncate">{{ provider.baseUrl }} · {{ provider.model }}</div>
          </div>
          <span v-if="provider.verified" class="badge badge-native">测试通过</span>
          <span v-else class="badge badge-warn">未验证</span>
          <span class="badge badge-api">API Key</span>
          <span v-if="provider.hasKey" class="text-[11px] text-slate-400">Key 已存</span>
          <button class="text-[12px] text-slate-400 hover:text-rose-600" @click="store.removeProvider(provider.id)">删除</button>
        </div>
      </div>

      <div class="panel col-span-2 p-5 space-y-3">
        <h2 class="text-sm font-semibold">新增 / 编辑</h2>
        <div>
          <label class="label">协议</label>
          <select v-model="form.protocol" class="input">
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="label">Provider 名称</label><input v-model="form.name" class="input" /></div>
          <div><label class="label">模型 ID</label>
            <select v-if="models.length" v-model="form.model" class="input mono"><option v-for="model in models" :key="model" :value="model">{{ model }}</option></select>
            <input v-else v-model="form.model" class="input mono" placeholder="gpt-4o-mini" />
          </div>
        </div>
        <div>
          <label class="label">Base URL</label>
          <input v-model="form.baseUrl" class="input mono" placeholder="https://api.openai.com/v1" />
        </div>
        <div>
          <label class="label">API Key（仅保存系统凭据引用）</label>
          <input v-model="form.apiKey" type="password" class="input mono" placeholder="留空表示沿用已保存的 Key" />
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div><label class="label">上下文</label><input v-model.number="form.contextLength" type="number" class="input" /></div>
          <div><label class="label">最大输出</label><input v-model.number="form.maxOutput" type="number" class="input" /></div>
          <div><label class="label">超时 ms</label><input v-model.number="form.timeoutMs" type="number" class="input" /></div>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary" @click="save">保存</button>
          <button class="btn" :disabled="testing" @click="fetchModels">拉取模型</button>
          <button class="btn" :disabled="testing" @click="test">测试连接</button>
          <button class="btn" @click="reset">清空</button>
        </div>
        <div v-if="result" class="rounded-lg bg-slate-50 border border-slate-200 p-3 text-[12px] text-slate-600 break-all">{{ result }}</div>
        <p class="text-[11px] text-slate-400 leading-relaxed">连接测试失败时不会保存为已验证状态。API 费用或套餐消耗由对应供应商承担。</p>
      </div>
    </div>
  </div>
</template>
