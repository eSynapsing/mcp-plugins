// Formato de account.json, el fichero que escribe configure-windows.ps1.
//
// Windows PowerShell 5.1 (powershell.exe) escribe UTF-8 CON BOM incluso
// cuando se pide -Encoding UTF8: no hay forma de evitarlo con los cmdlets
// normales de ese PowerShell. Node no quita el BOM al leer con 'utf8', y
// JSON.parse no lo acepta (lanza "Unexpected token"), asi que sin este paso
// la lectura fallaba en silencio: el conector se quedaba sin EMAIL_ADDRESS
// ni EMAIL_PASSWORD aunque el fichero estuviera bien escrito y el usuario
// hubiera completado la configuracion correctamente.
//
// configure-windows.ps1 ya escribe sin BOM (ver Set-Utf8NoBom en Dpapi.ps1),
// pero esta funcion tolera igualmente un BOM por si el fichero se edito a
// mano o lo escribio una version anterior del configurador.
export function parseAccountJson(raw) {
  const sinBom = raw.replace(/^\uFEFF/, '');
  return JSON.parse(sinBom);
}
