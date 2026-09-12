// The helper owns a Windows Job Object until every command descendant exits.
// Killing the helper closes its job handle and terminates all descendants, even
// when the command's original shell has already exited. Start suspended so no
// descendant can be created before assignment to the job. No native addon needed.
const jobRunner = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class TechunterCommandJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public IntPtr Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string command) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    ProcessInfo process = new ProcessInfo();
    try {
      ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      Startup startup = new Startup(); startup.Size = (uint)Marshal.SizeOf(typeof(Startup)); startup.Flags = 0x100;
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      Check(SetHandleInformation(startup.Input, 1, 1)); Check(SetHandleInformation(startup.Output, 1, 1)); Check(SetHandleInformation(startup.Error, 1, 1));
      Check(CreateProcess(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out process));
      if (!AssignProcessToJobObject(job, process.Process)) { int error = Marshal.GetLastWin32Error(); TerminateProcess(process.Process, 1); throw new Win32Exception(error); }
      if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
      Accounting info;
      do {
        Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (info.ActiveProcesses != 0) Thread.Sleep(25);
      } while (info.ActiveProcesses != 0);
      uint code; Check(GetExitCodeProcess(process.Process, out code)); return unchecked((int)code);
    } finally {
      CloseHandle(job);
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
    }
  }
}`;

export function windowsCommandInvocation(command: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const encodedCommand = Buffer.from(`$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding\n${command}`, 'utf16le').toString('base64');
  // Keep the helper command line bounded; consume the payload before starting
  // user commands so the transport variable is not inherited by setup/tests.
  const helper = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'\n$techunterCommandLine='powershell.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ' + $env:TECHUNTER_COMMAND_BASE64\n[Environment]::SetEnvironmentVariable('TECHUNTER_COMMAND_BASE64', $null, 'Process')\nAdd-Type -TypeDefinition @'\n${jobRunner}\n'@\nexit [TechunterCommandJob]::Run($techunterCommandLine)`;
  return { args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(helper, 'utf16le').toString('base64')],
    env: { ...process.env, TECHUNTER_COMMAND_BASE64: encodedCommand } };
}
