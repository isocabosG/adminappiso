import React from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root.jsx'
import { installSupabaseStorage } from './storageShim.js'
import { supabase } from './supabaseClient.js'

installSupabaseStorage()

// Helper de IA: la app lo llama en vez de a Anthropic directo.
// Va a la Edge Function 'ai-extract' de Supabase, que guarda la API key segura.
window.aiExtract = async (payload) => {
  const { data, error } = await supabase.functions.invoke('ai-extract', { body: payload })
  if (error) throw error
  if (data && data.error) throw new Error(data.error)
  return data
}

createRoot(document.getElementById('root')).render(<Root />)
