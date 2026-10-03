import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dos entradas independientes:
//   index.html     la app completa (Fran, Jesus, Constanza)
//   cobranza.html  solo estado de cuenta, para client.care
//
// Son bundles separados a proposito: cobranza.jsx NO importa App.jsx ni
// supabaseClient.js, asi que esa pagina ni siquiera trae el codigo que sabe
// leer adm_kv.
//
// Las rutas van relativas a la raiz del proyecto. Nada de __dirname: este
// archivo es ESM (package.json tiene "type": "module") y ahi __dirname no
// existe — tronaria el build en Vercel.
// __BUILD__ se reemplaza en tiempo de build por la fecha y hora reales del
// despliegue. Sirve para una sola cosa, pero importante: mirar el encabezado
// de la app y saber QUE version esta viva, sin terminal y sin dashboard.
export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(
      new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    ),
  },
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        cobranza: 'cobranza.html',
      },
    },
  },
})
