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

// Helper de ESCRITURA a Zoho. Va a la Edge Function 'zoho-write', que solo
// sabe cambiar el costo de compra de un articulo. Como en mrpEditar, aqui NO se
// traga el error: un costo que no se guardo tiene que verse.
window.zohoEscribir = async (payload) => {
  const { data, error } = await supabase.functions.invoke('zoho-write', { body: payload })
  if (error) throw new Error(await detalleError(error))
  if (data && data.ok === false && data.error) throw new Error(data.error)
  return data
}

// Helper de la limpieza de ordenes de venta. Va a la Edge Function
// 'so-limpieza'. Como en mrpEditar, el error NO se traga: una orden que no se
// pudo cambiar tiene que verse en la bitacora de la pantalla.
window.soLimpieza = async (payload) => {
  const { data, error } = await supabase.functions.invoke('so-limpieza', { body: payload })
  if (error) throw new Error(await detalleError(error))
  return data
}

// Helper del feed del MRP. Va a la Edge Function 'mrp-feed', que pega a IS-PMT
// (/api/mrp) con el token guardado del lado servidor. Devuelve { ok, proyectos[] }.
// El buscador con IA. Va a la Edge Function 'preguntar', que es la unica que
// ve los datos: el navegador solo manda el texto y pinta la respuesta. Como en
// mrpEditar, el error NO se traga — una respuesta que no se pudo calcular tiene
// que verse, no quedarse en blanco.
window.preguntar = async (payload) => {
  const { data, error } = await supabase.functions.invoke('preguntar', { body: payload })
  if (error) throw new Error(await detalleError(error))
  if (data && data.ok === false && data.error) throw new Error(data.error)
  return data
}

window.mrpFeed = async () => {
  const { data, error } = await supabase.functions.invoke('mrp-feed', { body: {} })
  if (error) throw new Error(await detalleError(error))
  if (data && data.error) throw new Error(data.error)
  return data
}

// Helper de ESCRITURA del MRP. Va a la Edge Function 'mrp-write', que agrega el
// correo del usuario autenticado como `actor` y pega a IS-PMT con el token de
// escritura. A diferencia de los demás, aquí NO se traga el error: si una
// corrección no se guardó, quien la hizo tiene que enterarse.
window.mrpEditar = async (cambio) => {
  const { data, error } = await supabase.functions.invoke('mrp-write', { body: cambio })
  if (error) throw new Error(await detalleError(error))
  if (data && data.ok === false) {
    // IS-PMT manda { ok:false, codigo, error }. El texto es para la pantalla;
    // el `codigo` es lo estable, y es con lo que la UI decide qué ofrecer
    // (p. ej. proponer el SKU vigente cuando el capturado está de baja).
    const e = new Error(data.error || 'No se pudo guardar el cambio.')
    e.codigo = data.codigo || null
    throw e
  }
  return data
}

createRoot(document.getElementById('root')).render(<Root />)
