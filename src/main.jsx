import React from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root.jsx'
import { installSupabaseStorage } from './storageShim.js'
import { supabase } from './supabaseClient.js'

installSupabaseStorage()

// Aplana un error que puede venir como texto o como objeto. Anthropic y Zoho
// contestan { error: { type, message } }; concatenar ese objeto daba el
// famoso "[object Object]" que escondia el motivo real (p.ej. saldo agotado).
function textoError(e) {
  if (e == null) return 'Error desconocido'
  if (typeof e === 'string') return e
  if (typeof e === 'object') return e.message || e.error_msg || e.type || JSON.stringify(e)
  return String(e)
}

// Saca el motivo REAL de un error de Edge Function. Supabase tira un error
// genérico ("non-2xx status code") y esconde el detalle en error.context (la
// Response). Aquí lo leemos para que el toast muestre la causa verdadera.
async function detalleError(error) {
  try {
    const body = await error?.context?.json?.()
    if (body?.error) return textoError(body.error)
    if (body?.message) return textoError(body.message)
  } catch {}
  return error?.message || String(error)
}

// Helper de IA: la app lo llama en vez de a Anthropic directo.
// Va a la Edge Function 'ai-extract' de Supabase, que guarda la API key segura.
window.aiExtract = async (payload) => {
  const { data, error } = await supabase.functions.invoke('ai-extract', { body: payload })
  if (error) throw new Error(await detalleError(error))
  if (data && data.error) throw new Error(textoError(data.error))
  return data
}

// Helper de lectura a Zoho Books (órdenes de compra). Va a la Edge Function 'zoho-books'.
window.zohoBooks = async (payload) => {
  const { data, error } = await supabase.functions.invoke('zoho-books', { body: payload })
  if (error) throw new Error(await detalleError(error))
  if (data && data.error) throw new Error(textoError(data.error))
  return data
}

// Helper de ESCRITURA a Zoho. Va a la Edge Function 'zoho-write', que solo
// sabe cambiar el costo de compra de un articulo. Como en mrpEditar, aqui NO se
// traga el error: un costo que no se guardo tiene que verse.
window.zohoEscribir = async (payload) => {
  const { data, error } = await supabase.functions.invoke('zoho-write', { body: payload })
  if (error) throw new Error(await detalleError(error))
  if (data && data.ok === false && data.error) throw new Error(textoError(data.error))
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
  if (data && data.ok === false && data.error) throw new Error(textoError(data.error))
  return data
}

// Pantalla de Usuarios. Toda la logica y el candado viven en la Edge Function
// `acceso`: aqui solo se manda la peticion. Como en mrpEditar, el error NO se
// traga — un cambio de acceso que no se aplico tiene que verse.
window.acceso = async (payload) => {
  const { data, error } = await supabase.functions.invoke('acceso', { body: payload })
  if (error) throw new Error(await detalleError(error))
  if (data && data.ok === false && data.error) throw new Error(textoError(data.error))
  return data
}

// Helper del AJUSTE POR CIERRE DE PROYECTO. Va a la Edge Function 'so-ajuste',
// que es la unica que escribe en Zoho. El permiso (profiles.puede_ajustar) lo
// revisa la funcion con el JWT de quien llama: esconder el boton en la app no
// es seguridad, es cortesia. Como en mrpEditar, el error NO se traga — un
// ajuste que no se aplico tiene que verse.
window.soAjuste = async (payload) => {
  const { data, error } = await supabase.functions.invoke('so-ajuste', { body: payload })
  if (error) throw new Error(await detalleError(error))
  if (data && data.ok === false && data.error) throw new Error(textoError(data.error))
  return data
}

// Botón "Actualizar de Zoho" del MRP. Las sincronías de madrugada siguen
// siendo las que mandan; esto es para cuando compras necesita ver AHORA un SKU
// recién creado o una orden de venta levantada hace un rato.
//
// La lista blanca está aquí y no en la pantalla a propósito: desde el navegador
// solo se puede pedir una de estas tres, y ninguna escribe en Zoho — las tres
// leen y dejan su blob en adm_kv. `inventario-sync` NO está: son ~2,300
// llamadas a Zoho y el tope diario lo comparten esta app, IS-PMT y los crons.
const SYNCS = ['catalogo-sync', 'comprometido-sync', 'oc-sync', 'gastos-sync', 'contratado-anio']
window.sincronizar = async (nombre) => {
  if (!SYNCS.includes(nombre)) throw new Error(`Sincronía no permitida: ${nombre}`)
  const { data, error } = await supabase.functions.invoke(nombre, { body: {} })
  if (error) throw new Error(await detalleError(error))
  if (data && data.ok === false && data.error) throw new Error(textoError(data.error))
  return data
}

window.mrpFeed = async () => {
  const { data, error } = await supabase.functions.invoke('mrp-feed', { body: {} })
  if (error) throw new Error(await detalleError(error))
  if (data && data.error) throw new Error(textoError(data.error))
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
    const e = new Error(textoError(data.error) || 'No se pudo guardar el cambio.')
    e.codigo = data.codigo || null
    throw e
  }
  return data
}

createRoot(document.getElementById('root')).render(<Root />)
