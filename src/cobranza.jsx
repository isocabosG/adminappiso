// Pantalla de cobranza — client.care@innovacionsolar.com
//
// Bundle aparte, a propósito. NO importa App.jsx ni supabaseClient.js: su
// código no sabe leer `adm_kv`. Todo lo que ve viene de la Edge Function
// `estado-de-cuenta`, que arma la vista del lado servidor y recorta lo que no
// le toca. Costos, inventario, tesorería e importaciones no viajan hasta acá.
//
// Tampoco usa Supabase Auth: esta persona no tiene cuenta en el proyecto,
// porque hoy una sesión válida equivale a acceso total a adm_kv. La función
// trae su propia autenticación.
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { LOGO_ISO } from "./logoISO.js";

const URL_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/estado-de-cuenta`;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
const LLAVE = "iso-cobranza-sesion";

const mx = (n) => "$" + (Number(n) || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const hoy = () => new Date().toISOString().slice(0, 10);

async function llamar(payload) {
  const r = await fetch(URL_FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (d?.expirado) { localStorage.removeItem(LLAVE); throw new Error("Tu sesión expiró. Vuelve a entrar."); }
  if (!r.ok || d?.ok === false) throw new Error(d?.error || `Error ${r.status}`);
  return d;
}

// Días desde la factura más vieja con saldo. Es lo que decide a quién llamar
// primero — no el monto. Una deuda chica de hace ocho meses es peor señal que
// una grande de la semana pasada.
const diasDe = (iso) => {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso + "T00:00:00").getTime()) / 86400000);
  return d >= 0 ? d : null;
};
const colorAnt = (d) => (d == null ? "text-stone-400" : d > 90 ? "text-red-700 font-semibold" : d > 60 ? "text-amber-700" : "text-stone-600");

function Entrar({ onEntra }) {
  const [email, setEmail] = useState("");
  const [clave, setClave] = useState("");
  const [err, setErr] = useState(null);
  const [cargando, setCargando] = useState(false);
  const enviar = async (e) => {
    e.preventDefault();
    setErr(null); setCargando(true);
    try {
      const d = await llamar({ accion: "entrar", email, clave });
      localStorage.setItem(LLAVE, JSON.stringify({ token: d.token, nombre: d.nombre }));
      onEntra({ token: d.token, nombre: d.nombre });
    } catch (e2) { setErr(String(e2.message || e2)); }
    finally { setCargando(false); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={enviar} className="w-full max-w-sm bg-white rounded-xl shadow-sm border border-stone-200 p-6 space-y-4">
        <img src={LOGO_ISO} alt="Innovación Solar" className="h-10 mx-auto" />
        <div className="text-center">
          <h1 className="text-base font-semibold text-stone-800">Estado de cuenta</h1>
          <p className="text-[11px] text-stone-500">Cobranza · Innovación Solar</p>
        </div>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Correo"
          className="w-full px-3 py-2 border border-stone-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600" />
        <input type="password" required value={clave} onChange={(e) => setClave(e.target.value)} placeholder="Contraseña"
          className="w-full px-3 py-2 border border-stone-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600" />
        {err && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{err}</p>}
        <button disabled={cargando} className="w-full py-2 bg-emerald-700 text-white text-sm font-medium rounded hover:bg-emerald-800 disabled:opacity-40">
          {cargando ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}

function pdfEstadoCuenta(p) {
  const EMP = { nombre: "INNOVACIÓN SOLAR", dir: "KM 3.5 Carretera CSL–SJC, Cabo San Lucas, B.C.S. 23454, México", tel: "+52 624 105 94 78", web: "www.innovacionsolar.com" };
  const filas = p.pagos.length
    ? p.pagos.map((x) => `<tr><td>${esc(x.fecha)}</td><td style="text-align:right">${mx(x.monto)} ${esc(x.moneda)}</td><td>${esc(x.forma)}</td><td>${esc(x.cuenta)}</td><td>${esc(x.referencia)}</td></tr>`).join("")
    : `<tr><td colspan="5" style="text-align:center;color:#888">Sin pagos registrados</td></tr>`;
  const fila = (k, v, cls = "") => `<tr><td>${k}</td><td style="text-align:right" class="${cls}">${v}</td></tr>`;
  const nombre = `Estado de cuenta - ${p.ov}${p.proyecto ? " - " + p.proyecto.replace(/[\\/:*?"<>|]+/g, " ") : ""}.pdf`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(nombre)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"><\/script>
<style>
  body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1a1d21;background:#eef1f0;margin:0;padding:18px}
  #doc{max-width:720px;margin:0 auto;background:#fff;padding:26px 30px;border-radius:8px}
  .head{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:3px solid #047857;padding-bottom:12px}
  .head img{height:42px}
  .co{text-align:right;font-size:10px;color:#6b7280;line-height:1.5}
  .co b{color:#047857;font-size:12px;letter-spacing:.03em}
  h1{font-size:19px;color:#065f46;margin:18px 0 2px}
  .sub{color:#6b7280;font-size:11px;margin:0 0 12px}
  .k{color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin:10px 0 2px}
  .v{font-size:14px;font-weight:600;margin:0}
  .row{display:flex;gap:28px;flex-wrap:wrap}
  .box{background:#f6faf8;border:1px solid #e3efe9;border-radius:10px;padding:12px 16px;margin:12px 0}
  .due{background:#fef2f2;border-color:#fecaca}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}
  th,td{padding:6px 8px;border-bottom:1px solid #eee;text-align:left}
  th{font-size:10px;text-transform:uppercase;color:#6b7280}
  .tot{font-size:15px;font-weight:700}
  .foot{margin-top:22px;border-top:1px solid #eee;padding-top:10px;font-size:10px;color:#9aa2ab;text-align:center;line-height:1.6}
  #status{max-width:720px;margin:10px auto 0;text-align:center;color:#6b7280;font-size:12px}
  @media print{ #status{display:none} @page{margin:12mm} body{background:#fff;padding:0} }
</style></head><body>
<div id="doc">
  <div class="head"><img src="${LOGO_ISO}" alt="Innovación Solar"/><div class="co"><b>${EMP.nombre}</b><br>${EMP.dir}<br>Tel: ${EMP.tel} · ${EMP.web}</div></div>
  <h1>Estado de cuenta</h1>
  <p class="sub">Fecha del reporte: ${hoy()}</p>
  <div class="row">
    <div><p class="k">Proyecto</p><p class="v">${esc(p.proyecto) || "—"}</p></div>
    <div><p class="k">Orden de venta</p><p class="v">${esc(p.ov)}</p></div>
    <div><p class="k">Cliente</p><p class="v">${esc(p.cliente) || "—"}</p></div>
    <div><p class="k">Moneda</p><p class="v">${esc(p.moneda)}</p></div>
  </div>
  <div class="box"><table>
    ${fila("Contratado (con IVA)", mx(p.contratadoConIva))}
    ${p.facturadoMXN ? fila("Facturado MXN", mx(p.facturadoMXN)) : ""}
    ${p.facturadoUSD ? fila("Facturado USD", mx(p.facturadoUSD)) : ""}
    ${p.cobradoMXN ? fila("Pagos aplicados MXN", mx(p.cobradoMXN)) : ""}
    ${p.cobradoUSD ? fila("Pagos aplicados USD", mx(p.cobradoUSD)) : ""}
  </table></div>
  <div class="box ${p.saldoMXN > 0.5 || p.saldoUSD > 0.5 ? "due" : ""}"><table>
    ${fila("<span class='tot'>Saldo por pagar MXN</span>", `<span class='tot'>${mx(p.saldoMXN)}</span>`)}
    ${p.saldoUSD ? fila("<span class='tot'>Saldo por pagar USD</span>", `<span class='tot'>${mx(p.saldoUSD)}</span>`) : ""}
    ${p.facturaMasViejaConSaldo ? fila("Factura más antigua con saldo", esc(p.facturaMasViejaConSaldo)) : ""}
    ${p.vencimientoMasViejo ? fila("Vencimiento más antiguo", esc(p.vencimientoMasViejo)) : ""}
  </table></div>
  <p class="k">Pagos aplicados</p>
  <table><thead><tr><th>Fecha</th><th style="text-align:right">Monto</th><th>Forma</th><th>Cuenta</th><th>Referencia</th></tr></thead><tbody>${filas}</tbody></table>
  <div class="foot">${EMP.nombre} · ${EMP.dir} · Tel: ${EMP.tel} · ${EMP.web}</div>
</div>
<p id="status">Generando el PDF…</p>
<script>
  window.addEventListener('load', function () {
    var s = document.getElementById('status'), el = document.getElementById('doc');
    if (window.html2pdf) {
      var opt = { margin: 10, filename: ${JSON.stringify(nombre)}, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' } };
      window.html2pdf().set(opt).from(el).save().then(function () { s.textContent = 'Listo — revisa tus Descargas. Ya puedes cerrar esta ventana.'; }).catch(function () { window.print(); });
    } else { setTimeout(function () { window.print(); }, 400); }
  });
<\/script></body></html>`;
  const w = window.open("", "_blank", "width=880,height=1000");
  if (!w) { alert("El navegador bloqueó la ventana. Permite las ventanas emergentes de este sitio."); return; }
  w.document.write(html); w.document.close();
}

function Panel({ sesion, onSalir }) {
  const [datos, setDatos] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [soloSaldo, setSoloSaldo] = useState(true);
  const [abierto, setAbierto] = useState(null);

  useEffect(() => {
    llamar({ accion: "proyectos", token: sesion.token })
      .then(setDatos)
      .catch((e) => { setErr(String(e.message || e)); if (String(e.message).includes("expiró")) setTimeout(onSalir, 1500); });
  }, []);

  if (err) return <div className="p-6"><p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">{err}</p></div>;
  if (!datos) return <p className="p-6 text-sm text-stone-500">Cargando…</p>;

  const t = q.trim().toLowerCase();
  const vistas = datos.proyectos.filter((p) => {
    if (soloSaldo && !(p.saldoMXN > 0.5 || p.saldoUSD > 0.5)) return false;
    if (!t) return true;
    return [p.ov, p.proyecto, p.cliente].some((x) => String(x).toLowerCase().includes(t));
  });
  const totMXN = vistas.reduce((a, p) => a + p.saldoMXN, 0);
  const totUSD = vistas.reduce((a, p) => a + p.saldoUSD, 0);

  return (
    <div className="min-h-screen">
      <header className="bg-gradient-to-r from-emerald-900 to-emerald-600 text-white px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <img src={LOGO_ISO} alt="Innovación Solar" className="h-8 bg-white/95 rounded px-1.5 py-1" />
          <div>
            <h1 className="text-base font-semibold">Estado de cuenta</h1>
            <p className="text-[10px] font-mono tracking-[0.2em] text-emerald-200">COBRANZA</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-emerald-100">{sesion.nombre}</span>
          <button onClick={onSalir} className="px-3 py-1.5 rounded-full border border-white/30 text-emerald-50 text-xs hover:bg-white/15">Salir</button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar proyecto, cliente u orden de venta…"
            className="flex-1 min-w-[220px] px-3 py-2 border border-stone-300 rounded text-sm" />
          <button onClick={() => setSoloSaldo((v) => !v)}
            className={`px-3 py-2 text-xs font-medium rounded border ${soloSaldo ? "bg-emerald-700 text-white border-emerald-700" : "bg-white text-stone-600 border-stone-300"}`}>
            Solo con saldo
          </button>
          <span className="text-xs text-stone-500">
            {vistas.length} proyecto(s) · por cobrar <b className="font-mono">{mx(totMXN)} MXN</b>
            {totUSD > 0.5 && <> · <b className="font-mono">{mx(totUSD)} USD</b></>}
          </span>
        </div>

        <p className="text-[10px] text-stone-400">
          Datos al corte del {datos.fecha || "—"}. Se actualizan cuando administración refresca los proyectos.
          {datos.pagosSinAsignar > 0 && <span className="text-amber-700"> · {datos.pagosSinAsignar} pago(s) no se pudieron asignar a una sola obra y no están contados.</span>}
        </p>

        <div className="bg-white border border-stone-200 rounded-lg overflow-x-auto">
          <table className="w-full text-[12px] min-w-[860px]">
            <thead className="bg-stone-100 text-[9px] uppercase tracking-wider text-stone-500">
              <tr>
                <th className="text-left px-3 py-2">Proyecto</th>
                <th className="text-left px-3 py-2">Cliente</th>
                <th className="text-left px-3 py-2">OV</th>
                <th className="text-right px-3 py-2">Contratado</th>
                <th className="text-right px-3 py-2">Pagos</th>
                <th className="text-right px-3 py-2 bg-amber-50 text-amber-800">Por cobrar</th>
                <th className="text-right px-3 py-2">Antigüedad</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {vistas.map((p) => {
                const d = diasDe(p.facturaMasViejaConSaldo);
                const ab = abierto === p.ov;
                return (
                  <React.Fragment key={p.ov}>
                    <tr onClick={() => setAbierto(ab ? null : p.ov)}
                      className={`border-t border-stone-100 cursor-pointer ${ab ? "bg-emerald-50" : "hover:bg-stone-50"}`}>
                      <td className="px-3 py-1.5 font-medium text-stone-800">{p.proyecto || "—"}</td>
                      <td className="px-3 text-stone-600">{p.cliente || "—"}</td>
                      <td className="px-3 font-mono text-stone-500">{p.ov}</td>
                      <td className="px-3 text-right font-mono">{mx(p.contratadoConIva)}</td>
                      <td className="px-3 text-right font-mono text-stone-500">{mx(p.cobradoMXN + p.cobradoUSD)}</td>
                      <td className={`px-3 text-right font-mono font-semibold bg-amber-50/60 ${p.saldoMXN + p.saldoUSD > 0.5 ? "text-amber-900" : "text-stone-300"}`}>
                        {mx(p.saldoMXN)}{p.saldoUSD > 0.5 && <span className="block text-[10px] font-normal">{mx(p.saldoUSD)} USD</span>}
                      </td>
                      <td className={`px-3 text-right font-mono ${colorAnt(d)}`}>{d != null ? `${d} d` : "—"}</td>
                      <td className="px-3 text-right">
                        <button onClick={(e) => { e.stopPropagation(); pdfEstadoCuenta(p); }}
                          className="px-2.5 py-1 bg-emerald-700 text-white text-[11px] font-medium rounded hover:bg-emerald-800 whitespace-nowrap">PDF</button>
                      </td>
                    </tr>
                    {ab && (
                      <tr className="bg-emerald-50/60">
                        <td colSpan={8} className="px-4 py-3">
                          <p className="text-[10px] uppercase tracking-widest text-emerald-700 mb-1">Pagos aplicados</p>
                          {p.pagos.length === 0 ? <p className="text-[12px] text-stone-500">Sin pagos registrados.</p> : (
                            <table className="w-full text-[11px]">
                              <thead className="text-[9px] uppercase tracking-wider text-stone-500">
                                <tr><th className="text-left py-0.5">Fecha</th><th className="text-right">Monto</th><th className="text-left pl-3">Forma</th><th className="text-left">Cuenta</th><th className="text-left">Referencia</th><th className="text-left">Origen</th></tr>
                              </thead>
                              <tbody>
                                {p.pagos.map((x, i) => (
                                  <tr key={i} className="border-t border-emerald-100">
                                    <td className="py-0.5">{x.fecha}</td>
                                    <td className="text-right font-mono">{mx(x.monto)} {x.moneda}</td>
                                    <td className="pl-3">{x.forma}</td><td>{x.cuenta}</td><td>{x.referencia}</td>
                                    <td className="text-stone-400">{x.origen}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          {p.facturaMasViejaConSaldo && (
                            <p className="text-[10px] text-stone-500 mt-2">
                              Factura más antigua con saldo: <b>{p.facturaMasViejaConSaldo}</b>
                              {p.vencimientoMasViejo && <> · vencía {p.vencimientoMasViejo}</>}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {vistas.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-sm text-stone-400">Nada con esos filtros.</td></tr>}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

function Cobranza() {
  const [sesion, setSesion] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LLAVE) || "null"); } catch { return null; }
  });
  const salir = () => { localStorage.removeItem(LLAVE); setSesion(null); };
  return sesion ? <Panel sesion={sesion} onSalir={salir} /> : <Entrar onEntra={setSesion} />;
}

createRoot(document.getElementById("root")).render(<Cobranza />);
