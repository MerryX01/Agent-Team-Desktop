import { createRouter, createWebHashHistory } from 'vue-router'
import DashboardPage from './pages/DashboardPage.vue'
import ChatPage from './pages/ChatPage.vue'
import AgentsPage from './pages/AgentsPage.vue'
import ProvidersPage from './pages/ProvidersPage.vue'
import TeamsPage from './pages/TeamsPage.vue'
import TasksPage from './pages/TasksPage.vue'
import SettingsPage from './pages/SettingsPage.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardPage },
    { path: '/chat', name: 'chat', component: ChatPage },
    { path: '/agents', name: 'agents', component: AgentsPage },
    { path: '/providers', name: 'providers', component: ProvidersPage },
    { path: '/teams', name: 'teams', component: TeamsPage },
    { path: '/tasks', name: 'tasks', component: TasksPage },
    { path: '/settings', name: 'settings', component: SettingsPage }
  ]
})
