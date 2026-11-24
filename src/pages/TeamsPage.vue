<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import { useAppStore } from '../stores/app'
import RolePicker from '../components/RolePicker.vue'
import { defaultPermissionPolicy, newId } from '@shared/index'
import type { Team, TeamMember } from '@shared/index'

type MemberDraft = { role: string; workflow: string; canWrite: boolean; isolation: 'none' | 'worktree'; pinned: boolean }

const store = useAppStore()
const selectedRoles = ref<Record<string, MemberDraft>>({})
const denyPatternsText = ref('')
const showWizard = ref(false)
const step = ref(1)
const wizard = ref({ name: '', folder: '', members: {} as Record<string, { role: string; workflow: string }> })

const current = computed(() => store.currentTeam)
const memberCount = computed(() => Object.keys(selectedRoles.value).length)

function emptyTeam(id = ''): Team {
  return {
    id, name: '', description: '', defaultWorkspace: '', maxConcurrency: 2,
    permissionMode: 'ask', isolation: 'none', policy: defaultPermissionPolicy(),
    leadAgentId: '', reviewFlow: 'agent_approval', reviewFlowPrompt: '', defaultActionMode: 'do'
  }
}

const draft = ref<Team>(emptyTeam())

function loadTeam() {
  const team = store.currentTeam
  if (!team) return
  draft.value = JSON.parse(JSON.stringify(team)) as Team
  const roles: Record<string, MemberDraft> = {}
  for (const member of store.members) {
    roles[member.agentId] = {
      role: member.role, workflow: member.workflow ?? '', canWrite: member.canWrite,
      isolation: member.isolation ?? 'none', pinned: Boolean(member.pinned)
    }
  }
  selectedRoles.value = roles
  denyPatternsText.value = (team.policy?.denyPatterns ?? []).join('\n')
}

watch(() => store.currentTeamId, loadTeam)
onMounted(() => {
  if (!store.teams.length) showWizard.value = true
  loadTeam()
})

async function saveTeam() {
  draft.value.policy.denyPatterns = denyPatternsText.value.split('\n').map((item) => item.trim()).filter(Boolean)
  const team: Team = { ...draft.value, id: draft.value.id || newId('team'), name: draft.value.name || '未命名群聊' }
  await store.saveTeam(team)
  draft.value = { ...team }
}

async function saveMembers() {
  const members: TeamMember[] = Object.entries(selectedRoles.value).map(([agentId, value], index) => ({
    teamId: store.currentTeamId, agentId, role: value.role, workflow: value.workflow,
    isolation: value.isolation, pinned: value.pinned, priority: index, canWrite: value.canWrite
  }))
  await store.setMembers(members)
}

function toggle(agentId: string, checked: boolean) {
  if (checked) selectedRoles.value[agentId] = { role: 'developer', workflow: '', canWrite: false, isolation: 'none', pinned: false }
  else delete selectedRoles.value[agentId]
}

function memberModel(agent: { kind: string; providerRef?: string; command?: string }): string {
  if (agent.kind === 'api-provider') return store.providers.find((p) => p.id === agent.providerRef)?.model ?? 'API 模型'
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
  await saveMembers()
}

async function pickFolder() {
  const path = await api.system.pickFolder()
  if (path) wizard.value.folder = path
}

function openWizard() {
  wizard.value = {
    name: '', folder: '',
    members: Object.fromEntries(store.agents.map((agent) => [agent.id, { role: agent.role || 'developer', workflow: agent.workflow ?? '' }]))
  }
  step.value = 1
  showWizard.value = true
}

function toggleWizardMember(id: string) {
  if (wizard.value.members[id]) delete wizard.value.members[id]
  else wizard.value.members[id] = { role: store.agents.find((a) => a.id === id)?.role || 'developer', workflow: '' }
}

async function createGroup() {
  const id = newId('team')
  const team: Team = {
    ...emptyTeam(id),
    name: wizard.value.name.trim() || '新建项目群聊',
    defaultWorkspace: wizard.value.folder.trim(),
    leadAgentId: store.agents.find((agent) => agent.isLead)?.id ?? ''
  }
  await store.saveTeam(team)
  const members: TeamMember[] = Object.entries(wizard.value.members).map(([agentId, value], index) => ({
    teamId: id, agentId, role: value.role, workflow: value.workflow,
    priority: index, canWrite: false, isolation: 'none', pinned: false
  }))
  await store.setMembers(members)
  showWizard.value = false
  store.notice = '群聊已创建，可以开始邀请 Agent 协作了'
  await store.refresh()
  loadTeam()
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-end justify-between">
      <div>
        <h1 class="text-xl font-bold text-slate-900">项目群聊</h1>
        <p class="text-[13px] text-slate-500 mt-1">你是群主。选定项目文件夹，拉 Agent 入群并分配角色，剩下的交给群聊协作。</p>
      </div>
      <button class="btn btn-primary" @click="openWizard">+ 新建群聊</button>
    </div>

    <div v-if="current" class="panel p-5 flex items-center gap-5">
      <div class="w-11 h-11 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-xl">👥</div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-[15px] font-semibold">{{ current.name }}</span>
          <span class="badge badge-native">群主：你</span>
        </div>
        <div class="text-[12px] text-slate-400 mono truncate mt-0.5">{{ current.defaultWorkspace || '未绑定项目文件夹' }}</div>
      </div>
      <div class="text-center"><div class="text-lg font-bold">{{ memberCount }}</div><div class="text-[11px] text-slate-400">群成员</div></div>
      <RouterLink class="btn btn-primary" to="/chat">进入群聊 →</RouterLink>
    </div>

    <div class="panel p-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="text-sm font-semibold">群成员与角色</h2>
          <p class="text-[11px] text-slate-400 mt-0.5">勾选即入群；角色决定职责提示词，工作流指令可补充个性化要求。</p>
        </div>
        <button class="btn btn-primary !py-1.5" @click="saveMembers">保存成员</button>
      </div>
      <table class="table">
        <thead><tr><th></th><th>成员</th><th>接入方式 / 模型</th><th>角色</th><th>工作流指令</th><th>工作树</th><th>固定</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="agent in store.agents" :key="agent.id">
            <td><input type="checkbox" :checked="Boolean(selectedRoles[agent.id])" @change="toggle(agent.id, ($event.target as HTMLInputElement).checked)" /></td>
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
            <td><RolePicker v-if="selectedRoles[agent.id]" v-model="selectedRoles[agent.id].role" compact /></td>
            <td>
              <input v-if="selectedRoles[agent.id]" v-model="selectedRoles[agent.id].workflow" class="input !py-1" placeholder="可选角色指令" />
              <span v-else class="text-slate-300">—</span>
            </td>
            <td><input v-if="selectedRoles[agent.id]" v-model="selectedRoles[agent.id].isolation" type="checkbox" true-value="worktree" false-value="none" /></td>
            <td><input v-if="selectedRoles[agent.id]" v-model="selectedRoles[agent.id].pinned" type="checkbox" /></td>
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
    </div>

    <details class="panel p-5">
      <summary class="cursor-pointer text-sm font-semibold text-slate-600">高级设置（群主配置）</summary>
      <div class="mt-5 grid grid-cols-2 gap-5">
        <div class="space-y-3">
          <div><label class="label">群聊名称</label><input v-model="draft.name" class="input" /></div>
          <div>
            <label class="label">项目文件夹</label>
            <div class="flex gap-2">
              <input v-model="draft.defaultWorkspace" class="input mono" placeholder="D:\\projects\\demo" />
              <button class="btn shrink-0" @click="api.system.pickFolder().then((p) => p && (draft.defaultWorkspace = p))">选择</button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="label">并发数</label><input v-model.number="draft.maxConcurrency" type="number" min="1" max="10" class="input" /></div>
            <div><label class="label">协调 Lead</label><select v-model="draft.leadAgentId" class="input"><option value="">不设置</option><option v-for="agent in store.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="label">审查流</label><select v-model="draft.reviewFlow" class="input"><option value="agent_approval">Agent 审查</option><option value="human_approval">人工批准</option><option value="lead_then_human">Lead 签核后人工批准</option></select></div>
            <div><label class="label">默认动作模式</label><select v-model="draft.defaultActionMode" class="input"><option value="do">DO 执行</option><option value="ask">ASK 只读</option><option value="delegate">DELEGATE 转交</option></select></div>
          </div>
          <div><label class="label">审查补充指令</label><input v-model="draft.reviewFlowPrompt" class="input" /></div>
          <div>
            <label class="label">危险命令模式（每行一个）</label>
            <textarea v-model="denyPatternsText" class="input mono" rows="2"></textarea>
          </div>
          <label class="text-[12px] text-slate-500 flex items-center gap-1"><input v-model="draft.policy.restrictToWorkspace" type="checkbox" /> 严格限制在项目文件夹内</label>
          <button class="btn btn-primary" @click="saveTeam">保存群聊设置</button>
        </div>
        <div>
          <h3 class="text-[13px] font-semibold mb-3">群聊模板</h3>
          <button class="btn !py-1.5 mb-3" @click="store.saveTemplate('team', draft.name, { team: draft, members: store.members }, draft.description)">保存当前为模板</button>
          <div v-for="template in store.templates.filter((t) => t.kind === 'team')" :key="template.id" class="flex items-center gap-3 border-b border-slate-100 py-2 text-[12px]">
            <div class="flex-1"><div class="font-medium">{{ template.name }}</div><div class="text-slate-400">{{ template.description }}</div></div>
            <button class="text-indigo-600" @click="store.applyTemplate(template.id)">应用</button>
          </div>
          <div v-if="!store.templates.filter((t) => t.kind === 'team').length" class="text-[12px] text-slate-400">暂无群聊模板</div>
        </div>
      </div>
    </details>

    <div v-if="showWizard" class="fixed inset-0 z-40 bg-slate-900/30 flex items-center justify-center p-6" @click.self="showWizard = false">
      <div class="w-[640px] panel p-6 shadow-xl">
        <div class="flex items-center justify-between mb-5">
          <div>
            <h2 class="text-lg font-bold">新建项目群聊</h2>
            <p class="text-[12px] text-slate-400 mt-1">三步完成：项目文件夹 → 邀请 Agent → 分配角色</p>
          </div>
          <button class="text-slate-400" @click="showWizard = false">✕</button>
        </div>
        <div class="flex gap-2 mb-5">
          <span v-for="n in 3" :key="n" class="badge" :class="step >= n ? 'badge-native' : 'badge-neutral'">{{ n }}</span>
        </div>

        <div v-if="step === 1" class="space-y-3">
          <div><label class="label">群聊名称</label><input v-model="wizard.name" class="input" placeholder="例如：官网重构群" /></div>
          <div>
            <label class="label">项目文件夹（Agent 只能在此目录内读写）</label>
            <div class="flex gap-2">
              <input v-model="wizard.folder" class="input mono" placeholder="选择项目目录" />
              <button class="btn shrink-0" @click="pickFolder">选择文件夹</button>
            </div>
          </div>
          <p class="text-[11px] text-slate-400">群主默认是你。项目文件夹决定 Agent 的工作边界与 Diff 来源。</p>
        </div>

        <div v-if="step === 2" class="grid grid-cols-2 gap-2 max-h-80 overflow-auto scroll-thin">
          <button v-for="agent in store.agents" :key="agent.id" class="flex items-center gap-2 p-2 rounded-lg border text-left" :class="wizard.members[agent.id] ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'" @click="toggleWizardMember(agent.id)">
            <span class="w-7 h-7 rounded-lg bg-white flex items-center justify-center">{{ agent.name.slice(0, 1) }}</span>
            <span class="flex-1 min-w-0"><span class="block text-[13px] truncate">{{ agent.name }}</span><span class="block text-[11px] text-slate-400">{{ agent.installed ? '已安装' : '未安装' }}</span></span>
            <span v-if="wizard.members[agent.id]" class="text-indigo-600">✓</span>
          </button>
        </div>

        <div v-if="step === 3" class="space-y-2 max-h-80 overflow-auto scroll-thin">
          <div v-for="(value, id) in wizard.members" :key="id" class="flex items-center gap-3 border-b border-slate-100 py-2">
            <span class="w-32 truncate text-[13px]">{{ store.agentById(id)?.name ?? id }}</span>
            <div class="flex-1"><RolePicker v-model="value.role" compact /></div>
            <input v-model="value.workflow" class="input !py-1 w-52" placeholder="工作流指令（可选）" />
          </div>
          <div v-if="!Object.keys(wizard.members).length" class="text-[12px] text-slate-400">还没有邀请成员，可返回上一步选择。</div>
        </div>

        <div class="flex justify-end gap-2 mt-6">
          <button v-if="step > 1" class="btn" @click="step--">上一步</button>
          <button v-if="step < 3" class="btn btn-primary" @click="step++">下一步</button>
          <button v-else class="btn btn-primary" @click="createGroup">创建群聊</button>
        </div>
      </div>
    </div>
  </div>
</template>
