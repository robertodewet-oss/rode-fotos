# RODE Fotos — Brief del proyecto

App web (PWA) para ver, indexar, buscar, etiquetar y exportar fotos de obra.
Dueño: Roberto Dewet (RODE HAUS, BCS). Ingeniero civil, programa herramientas propias con Claude.
Idioma de la interfaz: español. Debe ser amigable para compartirla con otras personas.

## Contexto
- Miles de fotos de obra. Cada proyecto/obra es una ubicación distinta (ej. ALH, LWH, CCH, SSH).
- Fuentes de fotos:
  1. **OneDrive personal** (cuenta Microsoft personal / Hotmail) — backup del celular. Leer desde la nube vía Microsoft Graph SIN descargar las fotos completas.
  2. **Carpetas locales** en la PC (ej. SSD externo). PC con Windows; navegador Chrome/Edge.
- Uso en PC y en celular.

## Requisitos — Versión 1
- **Conectar fuentes desde la interfaz**: botón "Conectar OneDrive" (login Microsoft con MSAL.js, elegir carpetas) y "Agregar carpeta de mi equipo" (File System Access API, solo PC).
- **Indexado**: fecha de captura, GPS, marca/modelo del dispositivo.
  - OneDrive: usar facets `photo` (takenDateTime, cameraMake, cameraModel) y `location` de Graph; delta query para actualizaciones incrementales; miniaturas vía `/thumbnails`.
  - Local: leer EXIF en el navegador (ej. exifr), generar miniaturas.
- **Proyectos por ubicación**: el usuario define cada obra en un mapa (punto + radio); las fotos con GPS se asignan automáticamente. Fotos sin GPS: asignación manual o por fecha/carpeta.
- **Interfaz**: cuadrícula de miniaturas al inicio (scroll virtual, miles de fotos); filtros combinables por proyecto, rango de fechas, dispositivo y etiquetas; vista de mapa; visor de foto completa.
- **Etiquetas y álbumes**: selección múltiple (clic, Shift-rango, "seleccionar todo lo filtrado") y asignar etiquetas.
- **Exportar selección**:
  - PC: copiar a una carpeta elegida (los originales nunca se mueven ni modifican).
  - Celular: descargar / compartir (Web Share API).
  - Opciones: renombrar `PROYECTO_AAAA-MM-DD_###.jpg` y reducir tamaño (ej. 2000 px).
- **Sin servidor propio**: índice, etiquetas, álbumes y miniaturas de carpetas locales se guardan en la carpeta de app de OneDrive del usuario (`/drive/special/approot`), para sincronizar PC ↔ celular. Caché local en IndexedDB.
- Multiusuario: cada persona entra con su propia cuenta Microsoft y solo ve sus fotos.

## Versión 2
- **Búsqueda en lenguaje natural** ("la foto que tomé en ALH de unas piezas de piso"): detectar el proyecto/fechas en la frase y ordenar por similitud visual con un modelo CLIP multilingüe corriendo en el navegador (transformers.js / WebGPU). Embeddings generados desde miniaturas grandes de Graph (sin descargar originales) y guardados en el índice en OneDrive.

## Pendientes de configuración (una sola vez, guiar a Roberto)
- Registrar la app en Microsoft Entra (cuentas personales y de trabajo; SPA; permisos `Files.Read`, `Files.ReadWrite.AppFolder`, `User.Read`).
- Crear cuenta de GitHub (no recuerda si tiene) y publicar en GitHub Pages (URL fija necesaria como redirect URI del login).

## Notas
- Nunca modificar, mover ni borrar fotos originales.
- Explicaciones a Roberto en español, directas y sin relleno.
