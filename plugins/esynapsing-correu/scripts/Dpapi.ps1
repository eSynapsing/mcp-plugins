# Cifrado y descifrado con DPAPI de Windows, llamando directamente a
# crypt32.dll por P/Invoke en vez de usar los cmdlets ConvertTo-SecureString /
# ConvertFrom-SecureString del modulo Microsoft.PowerShell.Security.
#
# Por que: ese modulo no siempre se puede cargar (visto en la practica con
# "El modulo no pudo cargarse... CouldNotAutoloadMatchingModule"), y cuando
# falla, falla tanto guardar la contrasena como leerla despues, asi que el
# conector deja de arrancar sin ningun aviso claro. Add-Type con P/Invoke usa
# una DLL del sistema operativo directamente, no un modulo de PowerShell, asi
# que no depende del mismo mecanismo de carga.
#
# Uso: punto de origen (dot-source) desde otro script:
#   . "$PSScriptRoot\Dpapi.ps1"
#   $texto_cifrado = Protect-Text "hola"
#   $texto_claro   = Unprotect-Text $texto_cifrado

if (-not ("DpapiNative" -as [type])) {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DpapiNative {
    [StructLayout(LayoutKind.Sequential)]
    internal struct DATA_BLOB {
        public int cbData;
        public IntPtr pbData;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool CryptProtectData(
        ref DATA_BLOB pDataIn, string szDataDescr, IntPtr pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool CryptUnprotectData(
        ref DATA_BLOB pDataIn, IntPtr ppszDataDescr, IntPtr pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

    private const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    public static byte[] Protect(byte[] data) {
        var input = new DATA_BLOB { cbData = data.Length, pbData = Marshal.AllocHGlobal(data.Length) };
        Marshal.Copy(data, 0, input.pbData, data.Length);
        var output = new DATA_BLOB();
        try {
            if (!CryptProtectData(ref input, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref output))
                throw new InvalidOperationException("No se pudo cifrar con DPAPI (CryptProtectData). Codigo: " + Marshal.GetLastWin32Error());
            var result = new byte[output.cbData];
            Marshal.Copy(output.pbData, result, 0, output.cbData);
            return result;
        } finally {
            Marshal.FreeHGlobal(input.pbData);
            if (output.pbData != IntPtr.Zero) Marshal.FreeHGlobal(output.pbData);
        }
    }

    public static byte[] Unprotect(byte[] data) {
        var input = new DATA_BLOB { cbData = data.Length, pbData = Marshal.AllocHGlobal(data.Length) };
        Marshal.Copy(data, 0, input.pbData, data.Length);
        var output = new DATA_BLOB();
        try {
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref output))
                throw new InvalidOperationException("No se pudo descifrar con DPAPI (CryptUnprotectData). Codigo: " + Marshal.GetLastWin32Error());
            var result = new byte[output.cbData];
            Marshal.Copy(output.pbData, result, 0, output.cbData);
            return result;
        } finally {
            Marshal.FreeHGlobal(input.pbData);
            if (output.pbData != IntPtr.Zero) Marshal.FreeHGlobal(output.pbData);
        }
    }
}
'@
}

function Protect-Text {
    param([Parameter(Mandatory = $true)][string]$PlainText)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($PlainText)
    [Convert]::ToBase64String([DpapiNative]::Protect($bytes))
}

function Unprotect-Text {
    param([Parameter(Mandatory = $true)][string]$Base64)
    $bytes = [DpapiNative]::Unprotect([Convert]::FromBase64String($Base64))
    [System.Text.Encoding]::UTF8.GetString($bytes)
}

# Lee una SecureString (por ejemplo de Read-Host -AsSecureString) como texto
# claro, sin pasar por ConvertFrom-SecureString.
function ConvertFrom-SecureStringPlain {
    param([Parameter(Mandatory = $true)][System.Security.SecureString]$Secure)
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}
