# =============================================================================
# THE WINDOWS BOUNDARY - a child process at LOW INTEGRITY, in a job object.
#
# Neither Docker nor WSL is present on a plain Windows machine, and the honest
# fallback used to be "a tidy folder" - code still ran as the user, with the
# user's rights, over the user's files. Windows itself offers a real boundary
# without installing anything and without administrator rights: a process whose
# token carries the LOW integrity label cannot write to the user's own files,
# because Windows refuses writes UP the integrity ladder. The rule is enforced
# by the kernel, not by this app's good intentions.
#
# What this gives, measured on a stock Windows 11 machine:
#   - the child runs at Mandatory Label\Low Mandatory Level (S-1-16-4096)
#   - it CAN write inside its own box, which is labelled Low so work is possible
#   - it CANNOT write to the user's documents or ordinary profile files: the
#     attempt is refused by the OS. It CAN still write the handful of places
#     Windows keeps writable at low integrity - AppData\LocalLow, the Low temp
#     folder, and HKCU\Software\AppDataLow - which are outside the box and
#     are NOT cleaned up with it. verify() probes all of them and reports
#     exactly which held, because "the profile is safe" was too broad a claim.
#   - it gets a scrubbed environment, so no API key reaches it
#   - it lives in a JOB OBJECT with kill-on-close, so the whole process TREE
#     dies with it - no orphan left running after a timeout
#
# What it does NOT give, said plainly because a half-claimed boundary is worse
# than none: low integrity blocks writing UP, not reading. A low-IL process can
# still READ files the user can read. This is a containment boundary against
# damage and modification, not a confidentiality boundary against a determined
# reader. Running scripts inside Docker or WSL is NOT implemented, so neither
# is claimed or used even when installed - detection reports them as present
# and nothing more.
#
# Invoked by sandbox.js. Compiles its interop ONCE into a cached assembly, so
# only the first run of an install pays the compiler.
# =============================================================================
param(
    [Parameter(Mandatory=$true)][string]$Cmd,      # full command line to run
    [Parameter(Mandatory=$true)][string]$Cwd,      # working directory (the box)
    [Parameter(Mandatory=$true)][string]$EnvFile,  # UTF8 file, one K=V per line
    [int]$TimeoutMs = 120000,
    [string]$AsmDir = ""                           # where to cache the compiled dll
)

$ErrorActionPreference = "Stop"

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class LclLowBox {
    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars,
                   dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr h, uint acc, out IntPtr tok);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool DuplicateTokenEx(IntPtr tok, uint acc, IntPtr attrs, int imp, int type, out IntPtr dup);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetTokenInformation(IntPtr tok, int cls, ref TOKEN_MANDATORY_LABEL info, int len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr tok, string app, string cmd,
        IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd,
        ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);

    // one flat block of "K=V\0...\0\0", which is what CreateProcessAsUser wants
    static IntPtr EnvBlock(string[] pairs) {
        StringBuilder sb = new StringBuilder();
        foreach (string p in pairs) { sb.Append(p); sb.Append('\0'); }
        sb.Append('\0');
        return Marshal.StringToHGlobalUni(sb.ToString());
    }

    // THE WHOLE POINT, IN ONE FUNCTION. Returns the child's exit code, or
    // -1 when it had to be killed for running past its time. Any failure to
    // build the boundary THROWS - a boundary that quietly did not happen is
    // the one outcome this must never report as success.
    public static bool TimedOut = false;

    public static int Run(string cmdline, string cwd, string[] env, int waitMs) {
        IntPtr tok, dup;
        // TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT
        if (!OpenProcessToken(GetCurrentProcess(), 0x0002 | 0x0008 | 0x0001 | 0x0080, out tok))
            throw new Exception("OpenProcessToken " + Marshal.GetLastWin32Error());
        if (!DuplicateTokenEx(tok, 0x02000000 /*MAXIMUM_ALLOWED*/, IntPtr.Zero,
                              2 /*SecurityImpersonation*/, 1 /*TokenPrimary*/, out dup))
            throw new Exception("DuplicateTokenEx " + Marshal.GetLastWin32Error());

        IntPtr lowSid;
        if (!ConvertStringSidToSid("S-1-16-4096", out lowSid))    // Low Mandatory Level
            throw new Exception("ConvertStringSidToSid " + Marshal.GetLastWin32Error());
        TOKEN_MANDATORY_LABEL tml = new TOKEN_MANDATORY_LABEL();
        tml.Label.Attributes = 0x00000020;                        // SE_GROUP_INTEGRITY
        tml.Label.Sid = lowSid;
        if (!SetTokenInformation(dup, 25 /*TokenIntegrityLevel*/, ref tml, Marshal.SizeOf(tml) + 12))
            throw new Exception("SetTokenInformation " + Marshal.GetLastWin32Error());

        // kill-on-close: when this process lets go of the job, every process in
        // it dies. That is how a timed-out script leaves nothing behind.
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job != IntPtr.Zero) {
            // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, LimitFlags at offset 16,
            // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
            int size = IntPtr.Size == 8 ? 144 : 112;
            IntPtr info = Marshal.AllocHGlobal(size);
            for (int i = 0; i < size; i++) Marshal.WriteByte(info, i, 0);
            Marshal.WriteInt32(info, IntPtr.Size == 8 ? 16 : 16, 0x2000);
            SetInformationJobObject(job, 9 /*ExtendedLimitInformation*/, info, (uint)size);
            Marshal.FreeHGlobal(info);
        }

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        PROCESS_INFORMATION pi;
        IntPtr envPtr = EnvBlock(env);
        // CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
        // suspended so the job is attached before a single instruction runs
        bool ok = CreateProcessAsUser(dup, null, cmdline, IntPtr.Zero, IntPtr.Zero, false,
                                      0x00000400 | 0x08000000 | 0x00000004,
                                      envPtr, cwd, ref si, out pi);
        int err = Marshal.GetLastWin32Error();
        Marshal.FreeHGlobal(envPtr);
        if (!ok) throw new Exception("CreateProcessAsUser " + err);

        if (job != IntPtr.Zero) AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);

        uint waited = WaitForSingleObject(pi.hProcess, (uint)waitMs);
        int result;
        TimedOut = false;
        if (waited == 0x00000102 /*WAIT_TIMEOUT*/) {
            if (job != IntPtr.Zero) TerminateJobObject(job, 1);
            // A SEPARATE FACT, NOT A MAGIC NUMBER. -1 is a legitimate exit code
            // (0xFFFFFFFF), so overloading it meant a script that simply
            // returned -1 was reported to the operator as "stopped: exceeded
            // 120s" - a sentence about something that never happened.
            TimedOut = true;
            result = -1;
        } else {
            uint code; GetExitCodeProcess(pi.hProcess, out code);
            result = (int)code;
        }
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        if (job != IntPtr.Zero) CloseHandle(job);          // kill-on-close sweeps the tree
        CloseHandle(dup); CloseHandle(tok);
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr h);
}
'@

# COMPILE ONCE PER INSTALL. Add-Type shells out to the .NET compiler, which is
# seconds the first time and nothing afterwards if the assembly is kept.
$loaded = $false
if ($AsmDir) {
    # VERSIONED BY THE SOURCE THAT BUILT IT. A fixed name meant an updated
    # launcher kept loading the PREVIOUS assembly forever: the new code was
    # ignored, and a property it added was missing at runtime. Found when a
    # timeout stopped being reported after the launcher changed.
    $sha = [System.BitConverter]::ToString(
        [System.Security.Cryptography.SHA1]::Create().ComputeHash(
            [System.Text.Encoding]::UTF8.GetBytes($src))).Replace("-","").Substring(0,12)
    $dll = Join-Path $AsmDir ("lcl-lowbox-" + $sha + ".dll")
    if (Test-Path $dll) {
        try { [Reflection.Assembly]::LoadFrom($dll) | Out-Null; $loaded = $true } catch { $loaded = $false }
    }
    if (-not $loaded) {
        New-Item -ItemType Directory -Force $AsmDir | Out-Null
        try {
            Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $dll -OutputType Library
            [Reflection.Assembly]::LoadFrom($dll) | Out-Null
            $loaded = $true
        } catch { $loaded = $false }
    }
}
if (-not $loaded) { Add-Type -TypeDefinition $src -Language CSharp }

$envPairs = @()
if (Test-Path $EnvFile) {
    $envPairs = @(Get-Content -Path $EnvFile -Encoding UTF8 | Where-Object { $_ -match "=" })
}

$code = [LclLowBox]::Run($Cmd, $Cwd, [string[]]$envPairs, $TimeoutMs)
# the ONLY thing on stdout is a machine-readable verdict; the child's own output
# went to its redirect file, inside the box
Write-Output ("LCLBOX-EXIT=" + $code)
# whether it was KILLED for running long, reported apart from its exit code
Write-Output ("LCLBOX-TIMEOUT=" + $(if ([LclLowBox]::TimedOut) { "1" } else { "0" }))
exit 0
