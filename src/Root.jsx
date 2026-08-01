import React, { useState, useEffect } from 'react'
import { supabase } from './supabaseClient.js'
import App from './App.jsx'
import Login from './Login.jsx'

export default function Root() {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (session === undefined)
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace', color: '#78716c' }}>Cargando…</div>
  if (!session) return <Login />
  return <App />
}
