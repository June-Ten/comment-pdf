import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import MupdfPreview from './views/MupdfPreview.vue'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'comments', component: App },
    { path: '/mupdf', name: 'mupdf', component: MupdfPreview },
  ],
})
