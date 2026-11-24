<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ROLE_CATALOG } from '@shared/index'

const props = defineProps<{
  modelValue: string
  placeholder?: string
  disabled?: boolean
  compact?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const query = ref('')
const customMode = ref(false)
const root = ref<HTMLElement | null>(null)

const selected = computed(() => ROLE_CATALOG.find((item) => item.value === props.modelValue))
const filtered = computed(() => ROLE_CATALOG.filter((item) => {
  const q = query.value.trim().toLowerCase()
  return !q || item.value.includes(q) || item.description.includes(q)
}))

function choose(value: string) {
  emit('update:modelValue', value)
  open.value = false
  query.value = ''
}

function chooseCustom() {
  customMode.value = true
  emit('update:modelValue', '')
  query.value = ''
}

function onOutside(event: MouseEvent) {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false
}

watch(() => props.modelValue, (value) => {
  if (value && !ROLE_CATALOG.some((item) => item.value === value)) customMode.value = true
  else customMode.value = false
}, { immediate: true })

onMounted(() => document.addEventListener('mousedown', onOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutside))
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="input flex items-center justify-between gap-2 text-left"
      :class="compact ? '!py-1' : ''"
      :disabled="disabled"
      @click="open = !open"
    >
      <span class="flex items-center gap-1.5 min-w-0 truncate">
        <span v-if="selected">{{ selected.icon }}</span>
        <span v-else>✏️</span>
        <span class="truncate">{{ modelValue || placeholder || '没有角色' }}</span>
      </span>
      <span class="text-slate-400 text-[10px]">▼</span>
    </button>

    <div v-if="open" class="absolute z-30 mt-1 w-full min-w-64 rounded-lg border border-slate-200 bg-white shadow-lg p-2">
      <input v-model="query" class="input mb-2" placeholder="搜索角色..." autofocus />
      <button class="w-full text-left px-2 py-1.5 rounded text-[13px] hover:bg-slate-100" @click="choose('')">— 没有角色</button>
      <button
        v-for="item in filtered" :key="item.value"
        class="w-full text-left px-2 py-1.5 rounded hover:bg-indigo-50 flex items-start gap-2"
        @click="choose(item.value)"
      >
        <span class="text-base leading-5">{{ item.icon }}</span>
        <span class="min-w-0">
          <span class="block text-[13px] font-medium text-slate-800">{{ item.label }}</span>
          <span class="block text-[11px] text-slate-400 truncate">{{ item.description }}</span>
        </span>
        <span v-if="modelValue === item.value" class="ml-auto text-indigo-600">✓</span>
      </button>
      <button class="w-full text-left px-2 py-1.5 rounded text-[13px] text-slate-600 hover:bg-slate-100 border-t border-slate-100 mt-1" @click="chooseCustom">
        ✏️ 自定义角色...
      </button>
      <div v-if="customMode" class="mt-2">
        <input
          :value="modelValue"
          class="input"
          placeholder="输入自定义角色，如 frontend-lead"
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        />
        <p class="text-[10px] text-slate-400 mt-1">自定义角色不会匹配内置职责提示词，可在工作流指令中写明职责。</p>
      </div>
    </div>
  </div>
</template>
