import React from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root.jsx'
import { installSupabaseStorage } from './storageShim.js'
import { supabase } from './supabaseClient.js'

installSupabaseStorage()

// Saca el motivo REAL de un error de Edge Function. Supabase tira un error
// genérico ("non-2xx status code") y esconde el detalle en error.context (la
// Response). Aquí lo leemos para que el toast muestre la causa verdadera.
async function detalleError(error) {
  try {
    const body = await error?.context?.json?.()
    if (body?.error) return body.error
    if (body?.message) return body.message
  } catch {}
  return error?.message || String(error)
}

// Helper de IA: la app lo llama en vez de a Anthropic directo.
// Va a la Edge Function 'ai-extract' de Supabase, que guarda la API key segura.
window.aiExtract = async (payload) => {
  const { data, error } = await supabase.functions.invoke('ai-extract', { body: payload })
  if (error) throw new Error(await detalleError(error))
  if (data && data.error) throw new Error(data.error)
  return data
}

// Helper de lectura a Zoho Books (órdenes de compra). Va a la Edge Function 'zoho-books'.
window.zohoBooks = async (payload) => {
  const { data, error } = await supabase.functions.invoke('zoho-books', { body: payload })
  if (error) throw new Error(await detalleError(error))
  if (data && data.error) throw new Error(data.error)
  return data
}

// Helper del feed del MRP. Va a la Edge Function 'mrp-feed', que pega a IS-PMT
// (/api/mrp) con el token guardado del lado servidor. Devuelve { ok, proyectos[] }.
window.mrpFeed = async () => {
  const { data, error } = await supabase.functions.invoke('mrp-feed', { body: {} })
  if (error) throw new Error(await detalleError(error))
  if (data && data.error) throw new Error(data.error)
  return data
}

createRoot(document.getElementById('root')).render(<Root />)
