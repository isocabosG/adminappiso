// Pantalla de Usuarios — AdminAppISO
//
// Archivo aparte a propósito: App.jsx pasa de 7,000 líneas y cada parche a
// ciegas ahí adentro ha costado una caída en producción.
//
// Aquí NO vive ningún permiso. Esta pantalla solo pinta y apaga controles por
// comodidad; quien impide es la Edge Function `acceso`, que vuelve a revisar
// quién llama en cada llamada. Si alguien llamara la función sin pasar por
// aquí, se toparía con la misma puerta.
import React, { useState, useEffect } from "react";

const ROLES = [
  ["direccion", "Dirección"],
  ["administracion", "Administración"],
  ["compras", "Compras"],
  ["cobranza", "Cobranza"],
  ["operacion", "Operación"],
];
const nombreRol = (r) => (ROLES.find(([k]) => k === r) || [null, r])[1];

// Lo que ve cada rol HOY. Si cambias PESTANAS_POR_ROL en App.jsx, cambia esto:
// una leyenda que miente es peor que no tenerla.
const QUE_VE = [
  ["direccion", "Todas las pantallas."],
  ["administracion", "Todas las pantallas."],
  ["compras", "Todas las pantallas."],
  ["cobranza", "Solo Proyectos, y sin el recuadro de utilidad ni compras de material."],
  ["operacion", "Todas las pantallas."],
];

export default function Usuarios({ setAviso }) {
  const [datos, setDatos] = useState(null);
  const [err, setErr] = useState(null);
  const [ocupado, setOcupado] = useState(null);
  const [nuevo, setNuevo] = useState({ email: "", clave: "", nombre: "", rol: "operacion" });
  const [creando, setCreando] = useState(false);

  const cargar = async () => {
    try { setDatos(await window.acceso({ accion: "listar" })); setErr(null); }
    catch (e) { setErr(String(e?.message || e)); }
  };
  useEffect(() => { cargar(); }, []);

  const hacer = async (payload, aviso) => {
    setOcupado(payload.userId || "nuevo");
    try {
      await window.acceso(payload);
      setAviso({ t: "ok", m: aviso });
      await cargar();
      return true;
    } catch (e) { setAviso({ t: "err", m: String(e?.message || e) }); return false; }
    finally { setOcupado(null); }
  };

  // La contraseña se pide, se manda y se olvida. No se devuelve en la
  // respuesta, no se escribe en ningún log y el campo se limpia solo. Entra,
  // se aplica y se va: se le da a la persona en directo.
  const cambiarClave = async (u) => {
    const clave = window.prompt(`Contraseña nueva para ${u.email}\n\nMínimo 8 caracteres. No se guarda en ningún lado: dásela a la persona en directo, aquí no se va a poder volver a ver.`);
    if (clave == null) return;
    if (clave.length < 8) { setAviso({ t: "err", m: "La contraseña debe tener al menos 8 caracteres." }); return; }
    await hacer({ accion: "clave", userId: u.id, clave }, `Contraseña cambiada para ${u.email}.`);
  };

  const crear = async (e) => {
    e.preventDefault();
    setCreando(true);
    const ok = await hacer({ accion: "crear", ...nuevo }, `Acceso creado para ${nuevo.email}.`);
    if (ok) setNuevo({ email: "", clave: "", nombre: "", rol: "operacion" });
    setCreando(false);
  };

  if (err) return <p className="text-xs text-red-700 bg-red-50 border border-red-300 rounded p-3">{err}</p>;
  if (!datos) return <p className="text-xs text-stone-500">Cargando accesos…</p>;

  const puedo = (u) => !u.protegido || datos.yo.esSuper;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Usuarios</h2>
        <p className="text-xs text-stone-500">
          Quién entra a la app y qué puede hacer. Las cuentas con 🔒 son de dirección y solo las toca Francisco.
        </p>
      </div>

      <form onSubmit={crear} className="bg-white border border-stone-200 rounded-lg p-3 grid gap-2 md:grid-cols-5 items-end">
        <label className="text-[10px] uppercase tracking-widest text-stone-400 md:col-span-2">Correo
          <input required type="email" value={nuevo.email} onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })}
            className="mt-0.5 w-full px-2 py-1.5 border border-stone-300 rounded text-xs normal-case tracking-normal" placeholder="nombre@innovacionsolar.com" />
        </label>
        <label className="text-[10px] uppercase tracking-widest text-stone-400">Nombre
          <input value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })}
            className="mt-0.5 w-full px-2 py-1.5 border border-stone-300 rounded text-xs normal-case tracking-normal" />
        </label>
        <label className="text-[10px] uppercase tracking-widest text-stone-400">Contraseña temporal
          <input required value={nuevo.clave} onChange={(e) => setNuevo({ ...nuevo, clave: e.target.value })}
            className="mt-0.5 w-full px-2 py-1.5 border border-stone-300 rounded text-xs normal-case tracking-normal" placeholder="mínimo 8" />
        </label>
        <div className="flex gap-2">
          <select value={nuevo.rol} onChange={(e) => setNuevo({ ...nuevo, rol: e.target.value })}
            className="flex-1 px-2 py-1.5 border border-stone-300 rounded text-xs bg-white">
            {ROLES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
          <button disabled={creando} className="px-3 py-1.5 bg-emerald-700 text-white text-xs font-medium rounded hover:bg-emerald-800 disabled:opacity-40">
            {creando ? "Creando…" : "Crear"}
          </button>
        </div>
      </form>

      <div className="bg-white border border-stone-200 rounded-lg overflow-x-auto">
        <table className="w-full text-xs min-w-[720px]">
          <thead className="bg-stone-100 text-[9px] uppercase tracking-wider text-stone-500">
            <tr>
              <th className="text-left px-3 py-2">Nombre</th>
              <th className="text-left px-3 py-2">Correo</th>
              <th className="text-left px-3 py-2">Rol</th>
              <th className="text-left px-3 py-2">Estado</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {datos.usuarios.map((u) => {
              const yo = u.id === datos.yo.id;
              const bloqueado = !puedo(u) || ocupado === u.id;
              return (
                <tr key={u.id} className={`border-t border-stone-100 ${u.activo ? "" : "bg-stone-50 text-stone-400"}`}>
                  <td className="px-3 py-1.5 font-medium">
                    {u.protegido && <span title="Cuenta de dirección: solo Francisco la puede tocar" className="mr-1">🔒</span>}
                    {u.full_name || "—"}
                    {yo && <span className="ml-1 text-[10px] text-stone-400">(tú)</span>}
                  </td>
                  <td className="px-3 font-mono text-stone-500">{u.email}</td>
                  <td className="px-3">
                    <select value={u.role} disabled={bloqueado || yo}
                      title={yo ? "Nadie se cambia el rol a sí mismo" : !puedo(u) ? "Cuenta protegida" : ""}
                      onChange={(e) => hacer({ accion: "rol", userId: u.id, rol: e.target.value }, `${u.full_name || u.email} ahora es ${nombreRol(e.target.value)}.`)}
                      className="px-2 py-1 border border-stone-300 rounded bg-white text-xs disabled:bg-stone-100 disabled:text-stone-400">
                      {ROLES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                    </select>
                  </td>
                  <td className="px-3">
                    {u.activo
                      ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">Activo</span>
                      : <span className="text-[10px] px-2 py-0.5 rounded-full bg-stone-200 text-stone-600">De baja</span>}
                    {/* Las dos señales tienen que coincidir. Si no, alguien
                        quedó a medias y sigue pudiendo entrar. */}
                    {u.activo === !!u.baneadoEnAuth && (
                      <span title="La bandera de la app y el bloqueo en Auth no coinciden. Vuelve a aplicar la baja o el alta." className="ml-1 text-amber-600">⚠</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <button onClick={() => cambiarClave(u)} disabled={bloqueado}
                      title={!puedo(u) ? "Cuenta protegida" : "Poner una contraseña nueva"}
                      className="px-2.5 py-1 border border-stone-300 text-stone-700 text-[11px] rounded hover:bg-stone-50 disabled:opacity-30">
                      Contraseña
                    </button>
                    <button
                      onClick={() => {
                        if (u.activo && !window.confirm(`¿Dar de baja a ${u.email}?\n\nNo se borra nada: la cuenta se desactiva y se bloquea el acceso. Su historial se conserva.`)) return;
                        hacer({ accion: u.activo ? "baja" : "alta", userId: u.id },
                          u.activo ? `${u.email} dado de baja.` : `${u.email} reactivado.`);
                      }}
                      disabled={bloqueado || yo}
                      title={yo ? "No puedes darte de baja a ti mismo" : !puedo(u) ? "Cuenta protegida" : ""}
                      className={`ml-1 px-2.5 py-1 text-[11px] rounded border disabled:opacity-30 ${
                        u.activo ? "border-red-300 text-red-700 hover:bg-red-50" : "border-emerald-300 text-emerald-700 hover:bg-emerald-50"}`}>
                      {u.activo ? "Dar de baja" : "Reactivar"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="border border-stone-200 rounded-lg p-3 bg-stone-50">
        <p className="text-xs font-semibold text-stone-700">Qué ve cada rol</p>
        <table className="mt-2 w-full text-[11px]">
          <tbody>
            {QUE_VE.map(([k, texto]) => (
              <tr key={k} className="align-top">
                <td className="py-0.5 pr-3 font-medium text-stone-700 whitespace-nowrap">{nombreRol(k)}</td>
                <td className="py-0.5 text-stone-500">{texto}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 leading-relaxed">
          Esconder una pestaña es comodidad, no permiso. Mientras la tabla de datos siga sin RLS, cualquier cuenta con
          sesión puede leer los mismos datos desde la consola del navegador. No le des acceso a alguien de fuera del
          equipo confiando en esta tabla.
        </p>
      </div>

      <p className="text-[10px] text-stone-400 leading-relaxed">
        La contraseña no se puede ver: la base guarda un hash y no hay vuelta atrás, ni para nosotros ni para Supabase.
        Lo único posible es poner otra. · Dar de baja no borra: desactiva la cuenta y bloquea el acceso, para que las
        bitácoras y los registros que apuntan a esa persona sigan cuadrando. · Quién administra accesos y qué cuentas
        están protegidas no se edita aquí — se cambia con una migración, que es un acto deliberado y queda escrito.
      </p>
    </div>
  );
}
