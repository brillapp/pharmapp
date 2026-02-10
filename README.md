# Ventas Offline (PWA) · Supabase

## Qué incluye
- PWA offline (IndexedDB + Service Worker)
- Módulos: Dashboard, Predicciones, Farmacias + Mis farmacias, Ópticas + Mis ópticas, Pedidos, Productos, Rutas, Visitas, Backup, Ajustes, Admin
- Multi-zona (por comunidades / CCAA o como tú quieras nombrarlas)
- Roles:
  - `delegado`: ve/usa su zona
  - `admin`: puede ver/editar perfiles, cambiar zona activa y hacer import/backup

## Despliegue (Cloudflare Pages)
Sube el contenido de esta carpeta como sitio estático.

## Configuración Supabase
1) Crea un proyecto Supabase.
2) Ejecuta `supabase/schema.sql` en SQL Editor.
3) Crea usuarios en Authentication > Users (con emails reales).
4) Edita los emails en `supabase/seed.sql` y ejecútalo (crea perfiles y roles).
5) En la app: Ajustes → pega:
   - Supabase URL (https://xxxx.supabase.co)
   - Supabase Anon Key

## Zonas / comunidades
- Cada usuario tiene un `zone` en `profiles`.
- El admin puede editar la zona y roles desde la pestaña Admin.
- La app trabaja con “zona activa”:
  - delegado: siempre su zona
  - admin: puede cambiarla en Admin (esto cambia los datos que sincroniza)

## Importaciones
### Farmacias
- Importar JSON (formato `data[]` con `codigo`, `direccion`, `cp`, `concello`, `telefono`, `titular1`, `lat`, `lon`)
- Importar KML (Placemark name=código; description con tabla HTML)

### Pedidos
- Importar JSON desde fichero o pegando:
  - Array de objetos con campos:
    - `cliente`
    - `estado`
    - `elementos`
    - `fecha` (YYYY-MM-DD)
    - `total_eur`

## Notas de sync
- La app guarda siempre en local.
- Cuando hay Supabase y sesión:
  - intenta subir cambios al guardar
  - si falla, los deja en outbox y reintenta en Sync o al volver a la app
- Conflictos: última escritura gana (best-effort).
