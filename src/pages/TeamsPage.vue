<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import { defaultPermissionPolicy, ROLE_CATALOG, newId } from '@shared/index'
import RolePicker from '../components/RolePicker.vue'
import type { Team } from '@shared/index'

const store = useAppStore()
const draft = ref<Team>({
  id: '', name: '', description: '', defaultWorkspace: '', maxConcurrency: 2,
  permissionMode: 'ask', isolation: 'none', policy: defaultPermissionPolicy(),
  leadAgentId: '', reviewFlow: 'agent_approval', reviewFlowPrompt: '', defaultActionMode: 'do'
})
const selectedRoles = ref<Record<string, { role: string; workflow: string; canWrite: boolean; isolation: 'none' | 'worktree'; pinned: boolean }>>({})
const denyPatternsText = ref('')

const members = computed(() => store.members)

watch(() => store.currentTeamId, () => {
  const team = store.currentTeam
  if (team) {
    draft.value = JSON.parse(JSON.stringify(team)) as Team
    const roles: Record<string, { role: string; workflow: string; canWrite: boolean; isolation: 'none' | 'worktree'; pinned: boolean }> = {}
    for (const member of store.members) roles[member.agentId] = { role: member.role, workflow: member.workflow ?? '', canWrite: member.canWrite, isolation: member.isolation ?? 'none', pinned: Boolean(member.pinned) }
    selectedRoles.value = roles
    denyPatternsText.value = (team.policy?.denyPatterns ?? []).join('\n')
  }
}, { immediate: true })

async function saveTeam() {
  draft.value.policy.denyPatterns = denyPatternsText.value.split('\n').map((item) => item.trim()).filter(Boolean)
  const team: Team = {
    ...draft.value,
    id: draft.value.id || newId('team'),
    name: draft.value.name || '未命名团队'
  }
  await store.saveTeam(team)
  draft.value = { ...team }
}

async function saveMembers() {
  const list = Object.entries(selectedRoles.value).map(([agentId, value], index) => ({
    teamId: store.currentTeamId, agentId, role: value.role, workflow: value.workflow ?? '', isolation: value.isolation, pinned: value.pinned, priority: index, canWrite: value.canWrite
  }))
  await store.setMembers(list)
}

function toggle(agentId: string, checked: boolean) {
  if (checked) selectedRoles.value[agentId] = { role: 'developer', workflow: '', canWrite: false, isolation: 'none', pinned: false }
  else delete selectedRoles.value[agentId]
}

function setRole(agentId: string, role: string) {
  if (selectedRoles.value[agentId]) selectedRoles.value[agentId].role = role
}

function memberModel(agent: { kind: string; providerRef?: string; command?: string }): string {
  if (agent.kind === 'api-provider') {
    return store.providers.find((provider) => provider.id === agent.providerRef)?.model ?? 'API 模型'
  }
  return agent.command || '本机 CLI'
}

function copyMember(agentId: string) {
  const role = selectedRoles.value[agentId]
  if (!role) return
  void navigator.clipboard?.writeText(JSON.stringify({ agentId, ...role }, null, 2))
  store.notice = '成员配置已复制'
}

async function removeMember(agentId: string) {
  delete selectedRoles.value[agentId]
  await store.setMembers(Object.entries(selectedRoles.value).map(([id, value], index) => ({
    teamId: store.currentTeamId, agentId: id, role: value.role, workflow: value.workflow,
    isolation: value.isolation, pinned: value.pinned, priority: index, canWrite: value.canWrite
  })))
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h1 class="text-xl font-bold text-slate-900">团队编排</h1>
      <p class="text-[13px] text-slate-500 mt-1">选择成员、角色、并发数与权限模式；调度由平台协调，不让不同厂商 Agent 私建连接。</p>
    </div>

    <div class="grid grid-cols-5 gap-4">
      <div class="panel col-span-2 p-5 space-y-3">
        <h2 class="text-sm font-semibold">团队配置</h2>
        <div><label class="label">团队名称</label><input v-model="draft.name" class="input" /></div>
        <div><label class="label">描述</label><input v-model="draft.description" class="input" /></div>
        <div>
          <label class="label">默认工作目录（绝对路径）</label>
          <input v-model="draft.defaultWorkspace" class="input mono" placeholder="D:\\projects\\demo" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label">最大并发数</label>
            <input v-model.number="draft.maxConcurrency" type="number" min="1" max="10" class="input" />
          </div>
          <div>
            <label class="label">权限模式</label>
            <select v-model="draft.permissionMode" class="input">
              <option value="ask">操作前询问</option>
              <option value="auto-deny">自动拒绝高风险操作</option>
              <option value="plan">仅规划</option>
            </select>
          </div>
          <div>
            <label class="label">工作树隔离</label>
            <select v-model="draft.isolation" class="input">
              <option value="none">共享工作目录</option>
              <option value="worktree">Git Worktree（仅 git 仓库）</option>
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label">协调 Lead</label>
            <select v-model="draft.leadAgentId" class="input">
              <option value="">不设置</option>
              <option v-for="agent in store.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
            </select>
          </div>
          <div>
            <label class="label">默认动作模式</label>
            <select v-model="draft.defaultActionMode" class="input">
              <option value="do">DO · 完整执行</option>
              <option value="ask">ASK · 只读</option>
              <option value="delegate">DELEGATE · 转交队友</option>
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label">审查流预设</label>
            <select v-model="draft.reviewFlow" class="input">
              <option value="agent_approval">Agent 审查后自动批准</option>
              <option value="human_approval">人工最终批准</option>
              <option value="lead_then_human">Lead 签核后人工批准</option>
            </select>
          </div>
          <div>
            <label class="label">审查流补充指令</label>
            <input v-model="draft.reviewFlowPrompt" class="input" placeholder="可选，注入 reviewer 提示词" />
          </div>
        </div>
        <div class="rounded-lg border border-slate-200 p-3 space-y-2">
          <div class="text-[12px] font-semibold text-slate-600">权限策略</div>
          <div class="grid grid-cols-2 gap-3">
            <div v-for="field in [
              { key: 'fileWrite', label: '文件写入' },
              { key: 'shellCommand', label: 'Shell 命令' },
              { key: 'network', label: '网络访问' },
              { key: 'installPackage', label: '安装依赖' }
            ]" :key="field.key">
              <label class="label">{{ field.label }}</label>
              <select v-model="draft.policy[field.key as 'fileWrite']" class="input">
                <option value="ask">询问</option><option value="allow">允许</option><option value="deny">拒绝</option>
              </select>
            </div>
          </div>
          <div>
            <label class="label">危险命令模式（每行一个）</label>
            <textarea v-model="denyPatternsText" class="input mono" rows="2"></textarea>
          </div>
          <label class="text-[12px] text-slate-500 flex items-center gap-1">
            <input v-model="draft.policy.restrictToWorkspace" type="checkbox" /> 严格限制在工作目录内
          </label>
        </div>
        <button class="btn btn-primary" @click="saveTeam">保存团队</button>
      </div>

      <div class="panel col-span-3 p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-semibold">成员与角色</h2>
          <button class="btn btn-primary !py-1.5" @click="saveMembers">保存成员</button>
        </div>
        <table class="table">
          <thead><tr><th></th><th>成员</th><th>接入方式 / 模型</th><th>角色（搜索/自定义）</th><th>工作流指令</th><th>工作树</th><th>固定</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="agent in store.agents" :key="agent.id">
              <td>
                <input type="checkbox" :checked="Boolean(selectedRoles[agent.id])" @change="toggle(agent.id, ($event.target as HTMLInputElement).checked)" />
              </td>
              <td>
                <div class="flex items-center gap-2">
                  <span class="w-7 h-7 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center text-[13px]">{{ agent.name.slice(0, 1) }}</span>
                  <div>
                    <div class="font-medium">{{ agent.name }}</div>
                    <div class="text-[11px] text-slate-400">{{ agent.installed ? '已安装' : '未安装' }} · {{ agent.role }}</div>
                  </div>
                </div>
              </td>
              <td>
                <span v-if="agent.authMode === 'native-login'" class="badge badge-native">本机账号</span>
                <span v-else-if="agent.authMode === 'api-key'" class="badge badge-api">API Key</span>
                <span v-else class="badge badge-warn">待验证</span>
                <div class="text-[11px] text-slate-400 mono truncate max-w-40">{{ memberModel(agent) }}</div>
              </td>
              <td>
                <RolePicker v-if="selectedRoles[agent.id]" v-model="selectedRoles[agent.id].role" compact />
              </td>
              <td>
                <input v-if="selectedRoles[agent.id]" v-model="selectedRoles[agent.id].workflow" class="input !py-1" placeholder="可选角色指令" />
                <span v-else class="text-slate-300">—</span>
              </td>
              <td>
                <input v-if="selectedRoles[agent.id]" v-model="selectedRoles[agent.id].isolation" type="checkbox" true-value="worktree" false-value="none" />
                <span v-else class="text-slate-300">—</span>
              </td>
              <td>
                <input v-if="selectedRoles[agent.id]" v-model="selectedRoles[agent.id].pinned" type="checkbox" />
                <span v-else class="text-slate-300">—</span>
              </td>
              <td>
                <div class="flex gap-2" v-if="selectedRoles[agent.id]">
                  <button class="text-[12px] text-indigo-600" @click="copyMember(agent.id)">复制</button>
                  <button class="text-[12px] text-slate-400 hover:text-rose-600" @click="removeMember(agent.id)">移除</button>
                </div>
                <span v-else class="text-slate-300">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="text-[11px] text-slate-400 mt-3">WorkBuddy 桌面版本地 ACP 尚未确认，不应标记为“复用本机额度”。</p>
      </div>
    </div>

    <div class="panel p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold">团队模板</h2>
        <button class="btn !py-1.5" @click="store.saveTemplate('team', draft.name, { team: draft, members: store.members }, draft.description)">保存当前为模板</button>
      </div>
      <div v-if="!store.templates.filter((t) => t.kind === 'team').length" class="text-[12px] text-slate-400">暂无团队模板</div>
      <div v-for="template in store.templates.filter((t) => t.kind === 'team')" :key="template.id" class="flex items-center gap-3 border-b border-slate-100 py-2 text-[12px]">
        <div class="flex-1">
          <div class="font-medium">{{ template.name }}</div>
          <div class="text-slate-400">{{ template.description }}</div>
        </div>
        <button class="text-indigo-600" @click="store.applyTemplate(template.id)">应用</button>
      </div>
    </div>
  </div>
</template>
