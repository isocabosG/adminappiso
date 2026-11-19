// Edge Function: reporte-cobranza
//
// El boton «Reportar lo que se ve» de la pantalla de Cobranza. Manda por correo
// (isonotifies, via send-mail de Quote Creator) la lista TAL COMO ESTA EN PANTALLA:
// los mismos renglones, en el mismo orden y con los filtros que la persona tenia
// puestos. Fran, 18-nov-2026: «un boton de reportar lo que se ve en pantalla y que
// eso se mande por iso notifies a Constanza, Jesus y Sergio».
//
// A QUIEN LE LLEGA
// No se manda `to` desde aqui. Los destinatarios los resuelve la tabla de send-mail
// con la clave `reporte:cobranza` (hoy: admin@ = Jesus, cbueno@ = Constanza,
// client.care@ y fvargas@). Es la misma lista que el aviso de las 10 am: dar de alta
// o de baja a alguien es un renglon en esa tabla, no un deploy.
//
// POR QUE PASA POR AQUI Y NO DIRECTO DEL NAVEGADOR
// send-mail solo acepta llamadas de servidor con la llave MAIL_KEY_COBRANZA, y esa
// llave no puede vivir en el bundle. Esta funcion exige sesion (verify_jwt) y que la
// cuenta este ACTIVA en `profiles`, firma el correo con el nombre de quien lo mando
// (sacado del JWT, no del cuerpo), y recorta tamaños para que nadie mande 5,000
// renglones a nombre de la empresa.
//
// El contenido viaja como ESTRUCTURA (columnas + filas de texto), nunca como HTML:
// el escape y el formato siguen siendo de send-mail.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SEND_MAIL = "https://leeblsvqoyaitqlmxwxh.supabase.co/functions/v1/send-mail";
const MAX_FILAS = 150, MAX_COLS = 10;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const txt = (v: unknown, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const SB = Deno.env.get("SUPABASE_URL"), SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);

  try {
    // Quien lo manda: del JWT, del lado servidor.
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SRV, Authorization: `Bearer ${jwt}` } });
    if (!u.ok) return json({ ok: false, error: "Sesion invalida. Vuelve a entrar." }, 401);
    const user = await u.json();
    const pr = await fetch(`${SB}/rest/v1/profiles?id=eq.${user.id}&select=full_name,activo`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    const perfil = (await pr.json().catch(() => []))?.[0];
    if (!perfil || perfil.activo === false) return json({ ok: false, error: "Tu cuenta no esta activa en la app." }, 403);
    const quien = txt(perfil.full_name || user.email, 80);

    const b = await req.json().catch(() => ({}));
    const columnas = (Array.isArray(b.columnas) ? b.columnas : []).slice(0, MAX_COLS).map((c: unknown) => txt(c, 40));
    const todas = Array.isArray(b.filas) ? b.filas : [];
    const filas = todas.slice(0, MAX_FILAS)
      .map((f: unknown) => (Array.isArray(f) ? f : []).slice(0, columnas.length).map((c) => txt(c, 120)));
    if (!columnas.length || !filas.length) return json({ ok: false, error: "No hay renglones que reportar con esos filtros." }, 400);
    const filtros = txt(b.filtros, 400);
    const totales = txt(b.totales, 300);

    // Fecha de Los Cabos (UTC-7 todo el año), no UTC.
    const hoy = new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
    const secciones: any[] = [
      { titulo: "Lo que se estaba viendo", tipo: "texto",
        texto: [filtros && `Filtros: ${filtros}`, totales && `Totales: ${totales}`].filter(Boolean).join("\n") || "Sin filtros: todo lo que tiene saldo." },
      { titulo: `Proyectos · ${todas.length}` + (todas.length > MAX_FILAS ? ` (van los primeros ${MAX_FILAS})` : ""),
        tipo: "tabla", columnas, filas },
    ];
    const datos = {
      titulo: `Cobranza · reporte de pantalla · ${todas.length} proyecto${todas.length === 1 ? "" : "s"}`,
      subtitulo: `Enviado por ${quien} · ${hoy}`,
      secciones,
    };

    const LLAVE = (Deno.env.get("MAIL_KEY_COBRANZA") ?? "").trim();
    if (!LLAVE) return json({ ok: false, error: "Falta el secreto MAIL_KEY_COBRANZA en este proyecto." }, 409);
    const r = await fetch(SEND_MAIL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-iso-key": LLAVE },
      body: JSON.stringify({ evento: "reporte", app: "cobranza", datos }),
    });
    const resp = await r.json().catch(() => ({}));
    // send-mail contesta 200 aunque el correo falle; lo que manda es su `ok`.
    if (!resp?.ok) return json({ ok: false, error: `El correo no salio: ${txt(resp?.error || r.status, 200)}` }, 502);
    return json({ ok: true, enviado: true, to: resp.to || [], asunto: resp.asunto || "" });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
