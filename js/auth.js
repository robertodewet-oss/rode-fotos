import { MSAL_CONFIG, GRAPH_SCOPES } from '../config.js'

let _msal = null

export async function initAuth() {
  if (!window.msal) throw new Error('MSAL.js no cargó. Verifica la conexión a internet.')
  _msal = new window.msal.PublicClientApplication(MSAL_CONFIG)
  await _msal.initialize()
  // Manejar redirección si viene de un flujo redirect (fallback)
  try { await _msal.handleRedirectPromise() } catch {}
}

export function getAccount() {
  if (!_msal) return null
  const accounts = _msal.getAllAccounts()
  return accounts[0] || null
}

export async function signIn() {
  if (!_msal) throw new Error('MSAL no inicializado')
  await _msal.loginPopup({ scopes: GRAPH_SCOPES })
  return getAccount()
}

export async function signOut() {
  const account = getAccount()
  if (!account || !_msal) return
  await _msal.logoutPopup({ account })
}

export async function getAccessToken() {
  if (!_msal) throw new Error('MSAL no inicializado')
  const account = getAccount()
  if (!account) throw new Error('No hay sesión activa')
  try {
    const r = await _msal.acquireTokenSilent({ scopes: GRAPH_SCOPES, account })
    return r.accessToken
  } catch (e) {
    if (e instanceof window.msal.InteractionRequiredAuthError) {
      const r = await _msal.acquireTokenPopup({ scopes: GRAPH_SCOPES, account })
      return r.accessToken
    }
    throw e
  }
}
