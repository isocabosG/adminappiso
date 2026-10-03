import React, { useState, useEffect } from 'react'
import { supabase } from './supabaseClient.js'
import App from './App.jsx'
import Login from './Login.jsx'

const esperando = (t) => (
  <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace', color: '#78716c' }}>{t}</div>
)

export default function Root() {
  const [session, setSession] = useState(undefined)
  const [perfil, setPerfil] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  // El perfil se resuelve en CADA carga, no solo al entrar. Dar de baja marca
  // `activo = false` y bloquea la cuenta en Auth, pero una sesion ya abierta
  // sigue viva hasta que expira: sin esta revision, quien sale de la empresa
  // seguiria entrando el resto del dia.
  useEffect(() => {
    if (!session) { setPerfil(undefined); return }
    let vivo = true
    supabase.from('profiles')
      .select('id, full_name, role, admin_accesos, es_super, activo')
      .eq('id', session.user.id).maybeSingle()
      .then(({ data }) => {
        if (!vivo) return
        if (data && data.activo === false) { supabase.auth.signOut(); return }
        // Sin perfil no se cierra la sesion: una cuenta recien creada, o la
        // migracion todavia sin correr, no deben dejar a nadie fuera. Entra
        // sin permisos extra.
        setPerfil(data || null)
      })
    return () => { vivo = false }
  }, [session])

  if (session === undefined) return esperando('Cargando…')
  if (!session) return <Login />
  if (perfil === undefined) return esperando('Verificando tu acceso…')
  return <App perfil={perfil} />
}
