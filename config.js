// ─── CONFIGURACIÓN DE MICROSOFT ENTRA (una sola vez) ───────────────────────
// 1. Ir a https://entra.microsoft.com → Registros de aplicaciones → Nuevo registro
// 2. Nombre: "RODE Fotos", tipo: "Cuentas personales de Microsoft"
// 3. URI de redirección: Aplicación de una página (SPA) → URL de GitHub Pages
//    Ejemplo: https://tuusuario.github.io/rode-fotos/
//    Para pruebas locales, agrega también: http://localhost:5500/
// 4. Permisos API → Agregar: Files.Read, Files.ReadWrite.AppFolder, User.Read
// 5. Copiar "Id. de aplicación (cliente)" y pegarlo abajo
// ────────────────────────────────────────────────────────────────────────────
export const CLIENT_ID = 'b9f81d72-ab88-4b77-aee9-c94699163b67'

export const MSAL_CONFIG = {
  auth: {
    clientId: CLIENT_ID,
    authority: 'https://login.microsoftonline.com/consumers',
    redirectUri: window.location.origin + window.location.pathname,
  },
  cache: {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: false,
  },
}

export const GRAPH_SCOPES = ['Files.Read', 'Files.ReadWrite.AppFolder', 'User.Read']

// Archivos guardados en la carpeta de app de OneDrive (/drive/special/approot)
export const APP_INDEX_FILE    = 'rode-fotos-index.json'
export const APP_PROJECTS_FILE = 'rode-fotos-projects.json'
export const APP_TAGS_FILE     = 'rode-fotos-tags.json'
export const APP_SOURCES_FILE  = 'rode-fotos-sources.json'

export const DB_NAME    = 'rode-fotos'
export const DB_VERSION = 2
