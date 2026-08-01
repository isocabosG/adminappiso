import React, { useState } from 'react'
import { supabase } from './supabaseClient.js'

export default function Login() {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const entrar = async () => {
    setLoading(true); setErr('')
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw })
    if (error) setErr('No se pudo entrar. Revisa correo y contraseña.')
    setLoading(false)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f4', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ width: 340, background: '#fff', border: '1px solid #e7e5e4', borderRadius: 12, padding: 24 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>AdminAppISO</h1>
        <p style={{ fontSize: 13, color: '#78716c', marginTop: 4 }}>Innovación Solar</p>
        <input type="email" placeholder="Correo" value={email} onChange={e => setEmail(e.target.value)}
          style={{ width: '100%', marginTop: 16, padding: '10px 12px', border: '1px solid #d6d3d1', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
        <input type="password" placeholder="Contraseña" value={pw} onChange={e => setPw(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && entrar()}
          style={{ width: '100%', marginTop: 8, padding: '10px 12px', border: '1px solid #d6d3d1', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
        {err && <p style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{err}</p>}
        <button onClick={entrar} disabled={loading || !email || !pw}
          style={{ width: '100%', marginTop: 16, padding: '10px', background: '#1c1917', color: '#fff', border: 0, borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: (loading || !email || !pw) ? 0.5 : 1 }}>
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
        <p style={{ fontSize: 11, color: '#a8a29e', marginTop: 12 }}>Los usuarios se crean en Supabase → Authentication → Users.</p>
      </div>
    </div>
  )
}
