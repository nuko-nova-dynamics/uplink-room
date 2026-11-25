# For the bridge's Windows console tests (#66): denies everyone the right to query the process with
# the given pid (PROCESS_QUERY_INFORMATION and PROCESS_QUERY_LIMITED_INFORMATION, which a console
# scan needs, and which Node's process.kill also asks for). -Unlock gives everyone every right again.
param([int]$Id, [switch]$Unlock)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LockProcess {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, int revision, out IntPtr descriptor, IntPtr size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetKernelObjectSecurity(IntPtr handle, int information, IntPtr descriptor);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool Run(int pid, string sddl) {
    IntPtr descriptor;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, IntPtr.Zero)) return false;
    IntPtr process = OpenProcess(0x40000, false, pid);
    if (process == IntPtr.Zero) return false;
    try { return SetKernelObjectSecurity(process, 4, descriptor); } finally { CloseHandle(process); }
  }
}
'@
$sddl = if ($Unlock) { 'D:(A;;0x1FFFFF;;;WD)' } else { 'D:(D;;0x1400;;;WD)(A;;0x1FFFFF;;;WD)' }
if (-not [LockProcess]::Run($Id, $sddl)) { exit 2 }
