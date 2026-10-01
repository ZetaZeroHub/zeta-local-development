$ErrorActionPreference = 'Stop'
try {
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ZetaCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential {
  public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
  public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool Write(ref Credential c, UInt32 flags);
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr c);
 [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool Delete(string target, UInt32 type, UInt32 flags);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
}
'@
$item = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = 'ZetaStudio.LocalDevelopment/' + $item.account
switch ($item.operation) {
 'set' {
  $bytes = [Text.Encoding]::UTF8.GetBytes($item.token)
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
   [Runtime.InteropServices.Marshal]::Copy($bytes,0,$blob,$bytes.Length)
   $entry = New-Object ZetaCredential+Credential
   $entry.Type=1; $entry.TargetName=$target; $entry.CredentialBlobSize=$bytes.Length
   $entry.CredentialBlob=$blob; $entry.Persist=2; $entry.UserName='ZetaStudio'
   if (-not [ZetaCredential]::Write([ref]$entry,0)) { exit 3 }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($blob) }
 }
 'get' {
  $ptr=[IntPtr]::Zero
  if (-not [ZetaCredential]::Read($target,1,0,[ref]$ptr)) { exit 4 }
  try {
   $entry=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][ZetaCredential+Credential])
   $bytes=New-Object byte[] $entry.CredentialBlobSize
   [Runtime.InteropServices.Marshal]::Copy($entry.CredentialBlob,$bytes,0,$bytes.Length)
   [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
  } finally { [ZetaCredential]::CredFree($ptr) }
 }
 'delete' { if (-not [ZetaCredential]::Delete($target,1,0) -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { exit 3 } }
 default { exit 2 }
}
} catch { exit 3 }
