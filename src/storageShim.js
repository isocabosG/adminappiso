import { supabase } from './supabaseClient.js'

/* Reemplaza window.storage (que usaba el artefacto) por almacenamiento en
   Supabase, sin tocar la lógica de la app. Guarda cada bloque de datos como
   un renglón JSON en la tabla adm_kv. Compartido entre todos los usuarios. */
export function installSupabaseStorage() {
  window.storage = {
    async get(key) {
      const { data, error } = await supabase
        .from('adm_kv').select('value').eq('key', key).maybeSingle()
      if (error) { console.error('storage.get', error); return null }
      return data ? { key, value: data.value } : null
    },
    async set(key, value) {
      const { error } = await supabase
        .from('adm_kv')
        .upsert({ key, value, updated_at: new Date().toISOString() })
      if (error) { console.error('storage.set', error); throw error }
      return { key, value }
    },
  }
}
