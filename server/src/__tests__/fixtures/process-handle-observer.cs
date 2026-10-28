using System;
using System.Runtime.InteropServices;

internal static class ProcessHandleObserver
{
    private const uint Synchronize = 0x00100000;
    private const uint QueryLimitedInformation = 0x00001000;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitTimeout = 0x00000102;
    private const uint StillActive = 259;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint Low; public uint High; }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static bool TryPid(string value, out uint pid)
    {
        return UInt32.TryParse(value, out pid) && pid > 0;
    }

    public static int Main(string[] args)
    {
        if (args.Length != 4) return 64;
        var pids = new uint[4];
        for (int i = 0; i < args.Length; i++)
        {
            if (!TryPid(args[i], out pids[i])) return 64;
            for (int prior = 0; prior < i; prior++) if (pids[prior] == pids[i]) return 64;
        }

        var handles = new IntPtr[4];
        var creationTimes = new long[4];
        try
        {
            for (int i = 0; i < pids.Length; i++)
            {
                handles[i] = OpenProcess(Synchronize | QueryLimitedInformation, false, pids[i]);
                if (handles[i] == IntPtr.Zero || GetProcessId(handles[i]) != pids[i]) return 2;
                FileTime creation, exit, kernel, user;
                if (!GetProcessTimes(handles[i], out creation, out exit, out kernel, out user)) return 2;
                creationTimes[i] = ((long)creation.High << 32) | creation.Low;
                if (creationTimes[i] <= 0 || WaitForSingleObject(handles[i], 0) != WaitTimeout) return 2;
            }

            Console.WriteLine("READY");
            Console.Out.Flush();
            uint wait = WaitForMultipleObjects((uint)handles.Length, handles, true, 25000);
            if (wait != WaitObject0) return 3;
            for (int i = 0; i < handles.Length; i++)
            {
                uint exitCode;
                if (!GetExitCodeProcess(handles[i], out exitCode) || exitCode == StillActive) return 4;
            }
            Console.WriteLine("CLOSED");
            Console.Out.Flush();
            return 0;
        }
        finally
        {
            foreach (IntPtr handle in handles) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
}
