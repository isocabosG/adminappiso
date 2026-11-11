// Barra de preguntas con IA, en el encabezado de la app.
//
// Vive en su propio archivo a propósito: App.jsx ya pasa de 7,000 líneas y cada
// parche a ciegas ahí adentro ha costado una caída en producción. Aquí App.jsx
// solo importa el componente y lo pone en el header.
//
// La inteligencia NO está aquí. Este archivo manda la pregunta a la Edge
// Function `preguntar` y pinta lo que contesta. Los datos, la aritmética y la
// prohibición de inventar viven del lado servidor, donde el navegador no puede
// saltárselos.
import React, { useState, useRef, useEffect } from "react";

// [11-nov-2026] Fran: «agrégale todas las preguntas que podríamos hacer».
//
// Cada pregunta de esta lista se probó contra las herramientas que la Edge
// Function `preguntar` realmente tiene: buscar, articulo, orden_de_venta,
// obra, ordenes_de_compra, que_falta_comprar, dinero (saldos / cobranza /
// pagos), importacion y estado_de_los_datos. Ninguna pregunta de aquí pide
// algo que no se pueda contestar, y por eso NO hay ejemplos de Limpieza,
// Usuarios ni Flujo: esas pantallas no tienen herramienta todavía. Un ejemplo
// que no se puede contestar enseña a desconfiar de la barra entera.
//
// Los nombres son obras y claves que existen hoy. Una pregunta con un nombre
// inventado falla en `buscar` y parece que la barra está rota.
const TEMAS = [
  {
    id: "material",
    titulo: "Material y MRP",
    preguntas: [
      "¿Qué falta comprar de las obras calendarizadas?",
      "Dame la lista de compra completa del MRP y cuánto vale",
      "¿Dónde está el SKU 16203: en almacén, apartado o en camino?",
      "¿Hay inversores Sol-Ark disponibles o están todos comprometidos?",
      "¿Qué obras piden baterías RENON y cuántas faltan?",
      "¿Qué material tiene stock final negativo?",
    ],
  },
  {
    id: "obras",
    titulo: "Obras",
    preguntas: [
      "¿Qué le falta a CHILENO GV 2A para poder instalar?",
      "¿Cuándo instala LARENA FASE 1 y ya tiene todo su material?",
      "¿Qué material de REMANSO 7 viene en camino y cuándo llega?",
      "¿Cuándo llega el generador de Casa Esmeralda?",
      "¿Qué trae pendiente la SO-01067?",
      "¿Qué le falta a PLAZA PEDREGAL y qué se le ha cobrado?",
    ],
  },
  {
    id: "compras",
    titulo: "Órdenes de compra",
    preguntas: [
      "¿Qué orden de compra llega más pronto y qué trae?",
      "¿Qué viene en camino de paneles?",
      "¿En qué orden de compra vienen las baterías y cuándo llegan?",
      "¿Qué órdenes de compra están abiertas?",
    ],
  },
  {
    id: "cobranza",
    titulo: "Cobranza",
    preguntas: [
      "¿Cuánto nos deben y quién es el más atrasado?",
      "¿Cuál es la factura más vieja sin cobrar?",
      "¿Qué pagos entraron últimamente?",
      "¿Cuánto se facturó y cuánto se ha cobrado de CHILENO 101 EXPANSION 2026?",
    ],
  },
  {
    id: "tesoreria",
    titulo: "Tesorería",
    preguntas: [
      "¿Cuánto hay en cada cuenta?",
      "¿Cuánto tenemos en dólares?",
      "¿Cuál es el saldo de BBVA?",
    ],
  },
  {
    id: "importaciones",
    titulo: "Importaciones",
    preguntas: [
      "¿Cuáles son los últimos pedimentos?",
      "¿A qué tipo de cambio entró el pedimento más reciente?",
      "¿Cuál fue el costo landed de los paneles importados?",
      "¿Qué trajo el pedimento 6004655?",
    ],
  },
  {
    id: "datos",
    titulo: "¿Está al día?",
    preguntas: [
      "¿Están actualizados los datos?",
      "¿Con qué fecha está el inventario físico?",
      "¿Cuándo fue la última sincronía de Zoho?",
    ],
  },
];

// Render mínimo: negritas, viñetas y saltos de línea. No se mete un motor de
// markdown completo por cuatro respuestas de texto.
function Texto({ children }) {
  const lineas = String(children || "").split("\n");
  return (
    <div className="space-y-1">
      {lineas.map((l, i) => {
        if (!l.trim()) return <div key={i} className="h-1" />;
        const vineta = /^\s*[-•*]\s+/.test(l);
        const partes = l.replace(/^\s*[-•*]\s+/, "").split(/(\*\*[^*]+\*\*)/g);
        return (
          <p key={i} className={`text-[13px] leading-relaxed text-stone-700 ${vineta ? "pl-4 relative" : ""}`}>
            {vineta && <span className="absolute left-1 text-stone-400">·</span>}
            {partes.map((x, j) =>
              x.startsWith("**") && x.endsWith("**")
                ? <b key={j} className="text-stone-900">{x.slice(2, -2)}</b>
                : <span key={j}>{x}</span>,
            )}
          </p>
        );
      })}
    </div>
  );
}

export default function Preguntar() {
  const [abierto, setAbierto] = useState(false);
  const [q, setQ] = useState("");
  const [cargando, setCargando] = useState(false);
  const [hilo, setHilo] = useState([]);      // [{rol, texto, pasos, error}]
  const [tema, setTema] = useState(TEMAS[0].id);
  const cajaRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { if (abierto) inputRef.current?.focus(); }, [abierto]);
  useEffect(() => { cajaRef.current?.scrollTo({ top: 0 }); }, [hilo]);

  // Cierra con Escape; abre con Cmd/Ctrl+K desde cualquier pantalla.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setAbierto(false);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setAbierto(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const preguntar = async (texto) => {
    const pregunta = String(texto ?? q).trim();
    if (!pregunta || cargando) return;
    setQ(""); setCargando(true); setAbierto(true);
    // El historial que se manda es solo texto plano: las llamadas a
    // herramientas se quedan del lado servidor.
    const historial = hilo.slice(0, 6).reverse()
      .filter((x) => !x.error)
      .flatMap((x) => [{ role: "user", content: x.pregunta }, { role: "assistant", content: x.texto }]);
    setHilo((h) => [{ pregunta, texto: "", pensando: true }, ...h]);
    try {
      const r = await window.preguntar({ pregunta, historial });
      if (r?.ok === false) throw new Error(r.error || "No se pudo contestar.");
      setHilo((h) => [{ pregunta, texto: r?.respuesta || "(sin respuesta)", pasos: r?.pasos || [], ms: r?.ms }, ...h.slice(1)]);
    } catch (e) {
      setHilo((h) => [{ pregunta, error: String(e?.message || e) }, ...h.slice(1)]);
    } finally { setCargando(false); }
  };

  return (
    <>
      {/* La barra del encabezado */}
      <div className="relative flex-1 max-w-md">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setAbierto(true)}
          onKeyDown={(e) => { if (e.key === "Enter") preguntar(); }}
          placeholder="Pregunta lo que sea…  ⌘K"
          className="w-full pl-8 pr-3 py-1.5 text-[12px] bg-white/10 border border-white/25 rounded-full text-white placeholder:text-white/50 focus:outline-none focus:bg-white/20 focus:border-white/50"
        />
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/60 text-[12px]">◎</span>
      </div>

      {/* El panel de respuestas */}
      {abierto && (
        <>
          <div className="fixed inset-0 z-40 bg-stone-900/20" onClick={() => setAbierto(false)} />
          <div className="fixed z-50 left-1/2 -translate-x-1/2 top-16 w-[min(760px,94vw)] bg-white rounded-xl shadow-2xl border border-stone-200 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-stone-100 bg-stone-50">
              <span className="text-teal-700 text-sm">◎</span>
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") preguntar(); }}
                placeholder="¿Qué quieres saber?"
                className="flex-1 bg-transparent text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none"
              />
              <button onClick={() => preguntar()} disabled={cargando || !q.trim()}
                className="px-3 py-1 bg-teal-700 text-white text-[11px] font-medium rounded-full disabled:opacity-30">
                {cargando ? "Consultando…" : "Preguntar"}
              </button>
              <button onClick={() => setAbierto(false)} className="text-stone-400 hover:text-stone-700 text-lg leading-none px-1">×</button>
            </div>

            <div ref={cajaRef} className="max-h-[65vh] overflow-y-auto">
              {hilo.length === 0 && (
                <div className="p-4">
                  {/* Los temas van en una fila que se desliza, no en una lista
                      larga: con siete temas abiertos a la vez la primera
                      pregunta queda a dos pantallas de scroll. */}
                  <div className="flex gap-1 overflow-x-auto pb-2 -mx-1 px-1">
                    {TEMAS.map((t) => (
                      <button key={t.id} onClick={() => setTema(t.id)}
                        className={`px-2.5 py-1 text-[11px] font-medium rounded-full border whitespace-nowrap ${
                          tema === t.id
                            ? "bg-teal-700 text-white border-teal-700"
                            : "border-stone-200 text-stone-500 hover:bg-stone-50"}`}>
                        {t.titulo}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-1 mt-1">
                    {(TEMAS.find((t) => t.id === tema) || TEMAS[0]).preguntas.map((e) => (
                      <button key={e} onClick={() => preguntar(e)}
                        className="block w-full text-left text-[13px] text-stone-600 hover:text-teal-800 hover:bg-teal-50 rounded px-2 py-1.5">
                        {e}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-stone-400 mt-3 border-t border-stone-100 pt-2">
                    Lee el catálogo, el inventario, las órdenes de compra y de venta, las obras de IS-PMT,
                    la cobranza, la tesorería y las importaciones — con el corte de la última sincronía.
                    Solo lee: no cambia nada en Zoho ni en la app. Si el dato no está, lo dice; no lo inventa.
                  </p>
                </div>
              )}

              {hilo.map((x, i) => (
                <div key={i} className="px-4 py-3 border-b border-stone-100 last:border-0">
                  <p className="text-[13px] font-medium text-stone-900 mb-1.5">{x.pregunta}</p>
                  {x.pensando && <p className="text-[12px] text-stone-400">Consultando los datos…</p>}
                  {x.error && (
                    <p className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded p-2">{x.error}</p>
                  )}
                  {x.texto && <Texto>{x.texto}</Texto>}
                  {x.pasos?.length > 0 && (
                    <p className="text-[10px] text-stone-400 mt-2">
                      Consultó: {[...new Set(x.pasos.map((p) => p.herramienta.replace(/_/g, " ")))].join(" · ")}
                      {x.ms ? ` · ${(x.ms / 1000).toFixed(1)}s` : ""}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
