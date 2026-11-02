// SPS Desktop Windows process-tree supervisor. A Job Object is process-tree
// containment only; this does not apply AppContainer or filesystem isolation.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
using System.Web.Script.Serialization;

internal static class WindowsJobSupervisor
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint Infinite = 0xffffffff;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint ProcessSynchronize = 0x00100000;
    private const uint ProcessQueryLimitedInformation = 0x00001000;
    private const uint ProcessTerminate = 0x00000001;
    private const uint ProcessSetQuota = 0x00000100;
    private const int ProcThreadAttributeHandleList = 0x00020002;
    private static readonly object PipeWriteLock = new object();
    private static readonly object JobLock = new object();
    private static NamedPipeServerStream pipe;
    private static IntPtr job = IntPtr.Zero;
    private static bool cancelRequested;
    private static bool pipeLost;
    private static bool naturalCompletion;
    private static string operationStage = "startup";
    private static readonly AutoResetEvent FatalControlFailure = new AutoResetEvent(false);

    [StructLayout(LayoutKind.Sequential)] private struct StartupInfo
    {
        public uint Size; public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCount, YCount, FillAttribute, Flags;
        public ushort ShowWindow, ReservedSize; public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes
    {
        public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    {
        public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] private struct JobAccounting
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodUserTime, ThisPeriodKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] private struct NativeFileTime { public uint Low, High; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int kind, out JobAccounting value, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out NativeFileTime creation, out NativeFileTime exit, out NativeFileTime kernel, out NativeFileTime user);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr bytes, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    private static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
        bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientPid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string descriptor, uint revision, out IntPtr securityDescriptor, out uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateNamedPipeW")]
    private static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances,
        uint outputBufferSize, uint inputBufferSize, uint defaultTimeout, ref SecurityAttributes securityAttributes);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    private static void Check(bool ok)
    {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static string ReadLineBounded(Stream stream, int maximum)
    {
        var bytes = new List<byte>();
        while (bytes.Count <= maximum)
        {
            int value = stream.ReadByte();
            if (value < 0)
            {
                if (bytes.Count == 0) return null;
                throw new InvalidDataException();
            }
            if (value == 10) return new UTF8Encoding(false, true).GetString(bytes.ToArray()).TrimEnd('\r');
            bytes.Add((byte)value);
        }
        throw new InvalidDataException();
    }

    private static void Send(object message)
    {
        string line = new JavaScriptSerializer().Serialize(message) + "\n";
        byte[] bytes = Encoding.UTF8.GetBytes(line);
        lock (PipeWriteLock)
        {
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
        }
    }

    private static bool HasExactKeys(Dictionary<string, object> value, params string[] keys)
    {
        if (value == null || value.Count != keys.Length) return false;
        foreach (string key in keys) if (!value.ContainsKey(key)) return false;
        return true;
    }

    private static NamedPipeServerStream CreatePipeServer(string pipeName)
    {
        SecurityIdentifier owner = WindowsIdentity.GetCurrent().User;
        if (owner == null) throw new UnauthorizedAccessException();
        string descriptor = "D:P(A;;GA;;;SY)(A;;GA;;;" + owner.Value + ")";
        IntPtr securityDescriptor;
        uint descriptorSize;
        Check(ConvertStringSecurityDescriptorToSecurityDescriptor(descriptor, 1, out securityDescriptor, out descriptorSize));
        try
        {
            var security = new SecurityAttributes();
            security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            security.Descriptor = securityDescriptor;
            security.InheritHandle = false;
            const uint PipeAccessDuplex = 0x00000003;
            const uint FileFlagFirstPipeInstance = 0x00080000;
            const uint FileFlagOverlapped = 0x40000000;
            // CreateNamedPipeW PIPE_REJECT_REMOTE_CLIENTS: remote connections are rejected automatically.
            // https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew
            const uint PipeRejectRemoteClients = 0x00000008;
            IntPtr raw = CreateNamedPipe("\\\\.\\pipe\\" + pipeName,
                PipeAccessDuplex | FileFlagOverlapped | FileFlagFirstPipeInstance,
                PipeRejectRemoteClients, 1, 4096, 4096, 0, ref security);
            if (raw == IntPtr.Zero || raw == new IntPtr(-1)) Check(false);
            var safeHandle = new SafePipeHandle(raw, true);
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, safeHandle); }
            catch { safeHandle.Dispose(); throw; }
        }
        finally { LocalFree(securityDescriptor); }
    }

    private static string QuoteArgument(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static IntPtr BuildEnvironment(object value)
    {
        var source = value as Dictionary<string, object>;
        if (source == null) throw new InvalidDataException();
        var names = new List<string>(source.Keys);
        var uniqueNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        names.Sort(StringComparer.OrdinalIgnoreCase);
        var block = new StringBuilder();
        foreach (string name in names)
        {
            object raw = source[name];
            if (String.IsNullOrEmpty(name) || name.IndexOf('=') >= 0 || name.IndexOf('\0') >= 0
                || !uniqueNames.Add(name) || !(raw is string)) throw new InvalidDataException();
            string item = (string)raw;
            if (item.IndexOf('\0') >= 0) throw new InvalidDataException();
            block.Append(name).Append('=').Append(item).Append('\0');
        }
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static void WaitForEmptyJob()
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(20);
        for (;;)
        {
            JobAccounting accounting;
            Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero));
            if (accounting.ActiveProcesses == 0) return;
            if (DateTime.UtcNow >= deadline) throw new TimeoutException();
            Thread.Sleep(20);
        }
    }

    private static void TerminateAndConfirm(uint code)
    {
        lock (JobLock)
        {
            if (job == IntPtr.Zero) throw new InvalidOperationException();
            Check(TerminateJobObject(job, code));
            WaitForEmptyJob();
        }
    }

    private static void ListenForControl()
    {
        try
        {
            for (;;)
            {
                string line = ReadLineBounded(pipe, 4096);
                if (line == null)
                {
                    lock (JobLock)
                    {
                        if (naturalCompletion) return;
                        pipeLost = true;
                    }
                    TerminateAndConfirm(125);
                    return;
                }
                var message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
                object type;
                if (!HasExactKeys(message, "type") || !message.TryGetValue("type", out type)
                    || !String.Equals(type as string, "cancel", StringComparison.Ordinal))
                    throw new InvalidDataException();
                lock (JobLock)
                {
                    if (naturalCompletion) return;
                    cancelRequested = true;
                }
                TerminateAndConfirm(125);
                Send(new Dictionary<string, object> { { "type", "cancelled" }, { "activeProcesses", 0 } });
                return;
            }
        }
        catch
        {
            lock (JobLock)
            {
                pipeLost = true;
                operationStage = "control-failure";
            }
            try { TerminateAndConfirm(125); } catch { }
            FatalControlFailure.Set();
        }
    }

    private static ProcessInfo StartChild(Dictionary<string, object> manifest)
    {
        object executableRaw, cwdRaw, argsRaw, envRaw;
        if (!HasExactKeys(manifest, "executable", "cwd", "args", "env")) throw new InvalidDataException();
        operationStage = "manifest-executable";
        if (!manifest.TryGetValue("executable", out executableRaw) || !(executableRaw is string)) throw new InvalidDataException();
        operationStage = "manifest-cwd";
        if (!manifest.TryGetValue("cwd", out cwdRaw) || !(cwdRaw is string)) throw new InvalidDataException();
        operationStage = "manifest-args";
        if (!manifest.TryGetValue("args", out argsRaw) || !(argsRaw is IList)) throw new InvalidDataException();
        IList arguments = (IList)argsRaw;
        operationStage = "manifest-env";
        if (!manifest.TryGetValue("env", out envRaw) || !(envRaw is Dictionary<string, object>)) throw new InvalidDataException();
        operationStage = "resolve-command";
        string executable = Path.GetFullPath((string)executableRaw);
        string cwd = Path.GetFullPath((string)cwdRaw);
        if (!Path.IsPathRooted(executable) || !Directory.Exists(cwd)) throw new InvalidDataException();
        var command = new StringBuilder(QuoteArgument(executable));
        foreach (object raw in arguments)
        {
            if (!(raw is string) || ((string)raw).IndexOf('\0') >= 0) throw new InvalidDataException();
            command.Append(' ').Append(QuoteArgument((string)raw));
        }

        operationStage = "build-environment";
        IntPtr environment = BuildEnvironment(envRaw);
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero, attributes = IntPtr.Zero, handleList = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        bool started = false;
        try
        {
            operationStage = "prepare-standard-handles";
            Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10), GetCurrentProcess(), out input, 0, true, 2));
            Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-11), GetCurrentProcess(), out output, 0, true, 2));
            Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-12), GetCurrentProcess(), out error, 0, true, 2));
            IntPtr required = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref required);
            attributes = Marshal.AllocHGlobal(required);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref required));
            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0, input); Marshal.WriteIntPtr(handleList, IntPtr.Size, output); Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, error);
            Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)ProcThreadAttributeHandleList, handleList,
                (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupInfoEx();
            startup.Startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Flags = StartfUseStdHandles;
            startup.Startup.Input = input; startup.Startup.Output = output; startup.Startup.Error = error;
            startup.Attributes = attributes;
            operationStage = "create-suspended";
            Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent, environment, cwd, ref startup, out child));
            operationStage = "assign-job";
            if (!AssignProcessToJobObject(job, child.Process))
            {
                int errorCode = Marshal.GetLastWin32Error();
                TerminateProcess(child.Process, 125);
                WaitForSingleObject(child.Process, Infinite);
                throw new Win32Exception(errorCode);
            }
            operationStage = "resume-child";
            if (ResumeThread(child.Thread) == UInt32.MaxValue)
            {
                int errorCode = Marshal.GetLastWin32Error();
                TerminateAndConfirm(125);
                throw new Win32Exception(errorCode);
            }
            started = true;
            return child;
        }
        finally
        {
            if (!started && child.Process != IntPtr.Zero)
            {
                try { if (job != IntPtr.Zero) TerminateAndConfirm(125); } catch { }
                if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
                CloseHandle(child.Process);
            }
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
        }
    }

    private static ulong ProcessCreationTime(IntPtr process)
    {
        NativeFileTime creation, exit, kernel, user;
        Check(GetProcessTimes(process, out creation, out exit, out kernel, out user));
        return ((ulong)creation.High << 32) | creation.Low;
    }

    private static bool TryReadUInt(Dictionary<string, object> message, string key, out uint value)
    {
        value = 0;
        object raw;
        if (!message.TryGetValue(key, out raw) || raw == null) return false;
        if (raw is int) { if ((int)raw < 0) return false; value = (uint)(int)raw; return true; }
        if (raw is long) { if ((long)raw < 0 || (ulong)(long)raw > UInt32.MaxValue) return false; value = (uint)(long)raw; return true; }
        if (raw is uint) { value = (uint)raw; return true; }
        if (raw is ulong) { if ((ulong)raw > UInt32.MaxValue) return false; value = (uint)(ulong)raw; return true; }
        return false;
    }

    private static int ProbeProcessCreation(string[] args)
    {
        uint processId;
        if (args.Length != 2 || !UInt32.TryParse(args[1], out processId) || processId == 0) return 64;
        IntPtr process = IntPtr.Zero;
        try
        {
            process = OpenProcess(ProcessQueryLimitedInformation | ProcessSynchronize, false, processId);
            Check(process != IntPtr.Zero);
            if (WaitForSingleObject(process, 0) != WaitTimeout) throw new InvalidOperationException();
            Console.Out.WriteLine(ProcessCreationTime(process).ToString(System.Globalization.CultureInfo.InvariantCulture));
            return 0;
        }
        catch
        {
            Console.Error.WriteLine("Windows process creation-time probe failed.");
            return 70;
        }
        finally { if (process != IntPtr.Zero) CloseHandle(process); }
    }

    private static int RunHost(string[] args)
    {
        uint expectedParentPid;
        if (args.Length != 4 || args[0] != "--supervise-host" || !UInt32.TryParse(args[2], out expectedParentPid)
            || expectedParentPid == 0 || args[3].Length != 64) return 64;
        string pipeName = args[1];
        if (pipeName.Length < 20 || pipeName.Length > 180 || pipeName.IndexOfAny(new[] { '\\', '/' }) >= 0) return 64;

        string channelNonce = expectedParentPid.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + pipeName + ":" + args[3];
        NamedPipeServerStream gate = null;
        ProcessInfo child = new ProcessInfo();
        bool hasChild = false;
        Thread control = null;
        var cancelSignal = new AutoResetEvent(false);
        try
        {
            operationStage = "host-control-connect";
            pipe = CreatePipeServer(pipeName);
            IAsyncResult connection = null;
            try { connection = pipe.BeginWaitForConnection(null, null); }
            catch (InvalidOperationException) { if (!pipe.IsConnected) throw; }
            if (connection != null)
            {
                if (!connection.AsyncWaitHandle.WaitOne(10000)) throw new TimeoutException();
                pipe.EndWaitForConnection(connection);
            }
            operationStage = "host-authenticate-client";
            uint clientPid;
            Check(GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out clientPid));
            if (clientPid != expectedParentPid) throw new InvalidDataException();
            Send(new Dictionary<string, object> { { "type", "hello" }, { "nonce", channelNonce } });

            operationStage = "host-prepare";
            string line = ReadLineBounded(pipe, 4096);
            if (line == null) throw new InvalidDataException();
            var prepare = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
            object prepareType, prepareNonce;
            if (!HasExactKeys(prepare, "type", "nonce") || !prepare.TryGetValue("type", out prepareType)
                || !String.Equals(prepareType as string, "prepare", StringComparison.Ordinal)
                || !prepare.TryGetValue("nonce", out prepareNonce) || !String.Equals(prepareNonce as string, channelNonce, StringComparison.Ordinal))
                throw new InvalidDataException();

            operationStage = "host-create-job";
            job = CreateJobObjectW(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            var limits = new ExtendedLimits();
            limits.Basic.Flags = JobObjectLimitKillOnJobClose;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));

            operationStage = "host-create-gate";
            string gateName = pipeName + "-gate";
            gate = CreatePipeServer(gateName);
            IAsyncResult gateConnection = null;
            try { gateConnection = gate.BeginWaitForConnection(null, null); }
            catch (InvalidOperationException) { if (!gate.IsConnected) throw; }
            Send(new Dictionary<string, object> { { "type", "prepared" }, { "gatePipe", gateName }, { "gateNonce", args[3] } });

            operationStage = "host-wait-attach";
            line = ReadLineBounded(pipe, 4096);
            if (line == null) throw new InvalidDataException();
            var attach = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
            object attachType;
            uint attachedPid;
            if (HasExactKeys(attach, "type") && attach.TryGetValue("type", out attachType)
                && String.Equals(attachType as string, "cancel", StringComparison.Ordinal))
            {
                TerminateAndConfirm(125);
                Send(new Dictionary<string, object> { { "type", "cancelled" }, { "activeProcesses", 0 } });
                return 125;
            }
            if (!HasExactKeys(attach, "type", "pid") || !attach.TryGetValue("type", out attachType)
                || !String.Equals(attachType as string, "attach", StringComparison.Ordinal)
                || !TryReadUInt(attach, "pid", out attachedPid) || attachedPid == 0) throw new InvalidDataException();

            var gateDone = new ManualResetEvent(false);
            string gateError = null;
            control = new Thread(() =>
            {
                try
                {
                    string controlLine = ReadLineBounded(pipe, 4096);
                    if (controlLine == null) throw new InvalidDataException();
                    var message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(controlLine);
                    object type;
                    if (!HasExactKeys(message, "type") || !message.TryGetValue("type", out type)
                        || !String.Equals(type as string, "cancel", StringComparison.Ordinal)) throw new InvalidDataException();
                    lock (JobLock)
                    {
                        if (naturalCompletion) return;
                        cancelRequested = true;
                        TerminateAndConfirm(125);
                        Send(new Dictionary<string, object> { { "type", "cancelled" }, { "activeProcesses", 0 } });
                    }
                    cancelSignal.Set();
                }
                catch
                {
                    lock (JobLock) { pipeLost = true; operationStage = "host-control-failure"; }
                    try { TerminateAndConfirm(125); } catch { }
                    FatalControlFailure.Set();
                }
            }) { IsBackground = true };
            control.Start();

            string gateFrame = null;
            gateError = null;
            var gateReader = new Thread(() =>
            {
                try
                {
                    operationStage = "host-wait-gate";
                    if (gateConnection != null)
                    {
                        if (!gateConnection.AsyncWaitHandle.WaitOne(15000)) throw new TimeoutException();
                        gate.EndWaitForConnection(gateConnection);
                    }
                    uint gatePid;
                    Check(GetNamedPipeClientProcessId(gate.SafePipeHandle.DangerousGetHandle(), out gatePid));
                    if (gatePid != attachedPid) throw new InvalidDataException();
                    gateFrame = ReadLineBounded(gate, 4096);
                    if (gateFrame == null) throw new InvalidDataException();
                }
                catch (Exception error) { gateError = error is TimeoutException ? "timeout" : "invalid"; }
                finally { gateDone.Set(); }
            }) { IsBackground = true };
            gateReader.Start();
            int signaled = WaitHandle.WaitAny(new WaitHandle[] { gateDone, cancelSignal, FatalControlFailure }, 15000);
            if (signaled == WaitHandle.WaitTimeout) { gate.Dispose(); throw new TimeoutException(); }
            if (signaled == 1) return 125;
            if (signaled == 2) throw new IOException();
            if (gateError != null) throw gateError == "timeout" ? (Exception)new TimeoutException() : new InvalidDataException();

            operationStage = "host-verify-process";
            var ready = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(gateFrame);
            object readyType, readyNonce, creationRaw;
            uint readyPid;
            ulong expectedCreation, actualCreation;
            if (!HasExactKeys(ready, "type", "nonce", "pid", "creationTime")
                || !ready.TryGetValue("type", out readyType) || !String.Equals(readyType as string, "host-ready", StringComparison.Ordinal)
                || !ready.TryGetValue("nonce", out readyNonce) || !String.Equals(readyNonce as string, args[3], StringComparison.Ordinal)
                || !TryReadUInt(ready, "pid", out readyPid) || readyPid != attachedPid
                || !ready.TryGetValue("creationTime", out creationRaw) || !(creationRaw is string)
                || !UInt64.TryParse((string)creationRaw, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out expectedCreation)
                || expectedCreation == 0
                || !String.Equals(expectedCreation.ToString(System.Globalization.CultureInfo.InvariantCulture), (string)creationRaw, StringComparison.Ordinal))
                throw new InvalidDataException();

            IntPtr process = OpenProcess(ProcessQueryLimitedInformation | ProcessSynchronize | ProcessTerminate | ProcessSetQuota, false, attachedPid);
            Check(process != IntPtr.Zero);
            child.Process = process;
            child.ProcessId = attachedPid;
            hasChild = true;
            actualCreation = ProcessCreationTime(process);
            if (actualCreation != expectedCreation || WaitForSingleObject(process, 0) != WaitTimeout) throw new InvalidDataException();

            operationStage = "host-assign-job";
            lock (JobLock)
            {
                if (pipeLost || cancelRequested) return 125;
                Check(AssignProcessToJobObject(job, process));
                byte[] admitted = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                    { "type", "admitted" }, { "nonce", args[3] }
                }) + "\n");
                gate.Write(admitted, 0, admitted.Length); gate.Flush();
                operationStage = "host-report-ready";
                Send(new Dictionary<string, object> { { "type", "ready" } });
            }

            operationStage = "host-wait-process";
            IntPtr[] waitHandles = { child.Process, FatalControlFailure.SafeWaitHandle.DangerousGetHandle(), cancelSignal.SafeWaitHandle.DangerousGetHandle() };
            uint waitResult = WaitForMultipleObjects((uint)waitHandles.Length, waitHandles, false, Infinite);
            if (waitResult == 1) throw new IOException();
            if (waitResult == 2) return 125;
            Check(waitResult == WaitObject0);
            uint childExitCode;
            Check(GetExitCodeProcess(child.Process, out childExitCode));
            bool cancelled;
            lock (JobLock)
            {
                if (pipeLost) throw new IOException();
                cancelled = cancelRequested;
                if (!cancelled)
                {
                    operationStage = "host-confirm-job-empty";
                    TerminateAndConfirm(childExitCode);
                    naturalCompletion = true;
                }
            }
            if (cancelled)
            {
                if (!control.Join(21000)) throw new TimeoutException();
                lock (JobLock) if (pipeLost) throw new IOException();
            }
            else Send(new Dictionary<string, object> { { "type", "exit" }, { "code", childExitCode }, { "activeProcesses", 0 } });
            return cancelled ? 125 : unchecked((int)childExitCode);
        }
        catch (Exception error)
        {
            string category = error is TimeoutException ? "timeout"
                : error is UnauthorizedAccessException ? "access"
                : error is System.Security.SecurityException ? "security"
                : error is IOException ? "io"
                : error is ArgumentException ? "argument"
                : error is Win32Exception ? "win32"
                : error is InvalidDataException ? "invalid-data"
                : "other";
            try { Send(new Dictionary<string, object> { { "type", "error" }, { "code", "supervisor-failed" }, { "stage", operationStage }, { "category", category } }); } catch { }
            try { if (job != IntPtr.Zero) TerminateAndConfirm(125); } catch { }
            Console.Error.WriteLine("Windows Host process supervision failed (" + operationStage + "," + category + ").");
            return 70;
        }
        finally
        {
            if (control != null && control.IsAlive) control.Join(1000);
            if (hasChild && child.Process != IntPtr.Zero) CloseHandle(child.Process);
            if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            if (gate != null) gate.Dispose();
            if (pipe != null) { pipe.Dispose(); pipe = null; }
            cancelSignal.Dispose();
        }
    }

    private static int Run(string[] args)
    {
        uint expectedParentPid;
        if (args.Length != 4 || args[0] != "--supervise" || !UInt32.TryParse(args[2], out expectedParentPid)
            || args[3].Length != 64) return 64;
        string pipeName = args[1];
        if (pipeName.Length < 20 || pipeName.Length > 180 || pipeName.IndexOfAny(new[] { '\\', '/' }) >= 0) return 64;
        ProcessInfo child = new ProcessInfo();
        bool hasChild = false;
        try
        {
            operationStage = "pipe-create";
            pipe = CreatePipeServer(pipeName);
            operationStage = "pipe-connect";
            if (!pipe.IsConnected)
            {
                operationStage = "pipe-connect-begin";
                IAsyncResult connection = null;
                try { connection = pipe.BeginWaitForConnection(null, null); }
                catch (InvalidOperationException)
                {
                    // The Node client can connect between IsConnected and BeginWaitForConnection.
                    if (!pipe.IsConnected) throw;
                }
                if (connection != null)
                {
                    operationStage = "pipe-connect-wait";
                    if (!connection.AsyncWaitHandle.WaitOne(10000)) throw new TimeoutException();
                    operationStage = "pipe-connect-end";
                    pipe.EndWaitForConnection(connection);
                }
            }
            operationStage = "authenticate-client";
            uint clientPid;
            Check(GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out clientPid));
            if (clientPid != expectedParentPid) throw new InvalidDataException();
            string channelNonce = args[2] + ":" + args[1] + ":" + args[3];
            string hello = new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "type", "hello" }, { "nonce", channelNonce } }) + "\n";
            byte[] greeting = Encoding.UTF8.GetBytes(hello);
            pipe.Write(greeting, 0, greeting.Length); pipe.Flush();
            operationStage = "read-manifest";
            string line = ReadLineBounded(pipe, 262144);
            if (line == null) throw new InvalidDataException();
            var start = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
            object typeValue, nonceValue, manifestValue;
            if (!HasExactKeys(start, "type", "nonce", "manifest") || !start.TryGetValue("type", out typeValue) || (string)typeValue != "start"
                || !start.TryGetValue("nonce", out nonceValue) || (string)nonceValue != channelNonce
                || !start.TryGetValue("manifest", out manifestValue) || !(manifestValue is Dictionary<string, object>)) throw new InvalidDataException();

            operationStage = "create-job";
            job = CreateJobObjectW(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            var limits = new ExtendedLimits();
            limits.Basic.Flags = JobObjectLimitKillOnJobClose;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            child = StartChild((Dictionary<string, object>)manifestValue);
            hasChild = true;
            operationStage = "report-ready";
            Send(new Dictionary<string, object> { { "type", "ready" }, { "pid", child.ProcessId } });
            var control = new Thread(ListenForControl) { IsBackground = true };
            control.Start();

            operationStage = "wait-child";
            IntPtr[] waitHandles = { child.Process, FatalControlFailure.SafeWaitHandle.DangerousGetHandle() };
            uint waitResult = WaitForMultipleObjects((uint)waitHandles.Length, waitHandles, false, Infinite);
            if (waitResult == 1) throw new IOException();
            Check(waitResult == 0);
            uint childExitCode;
            Check(GetExitCodeProcess(child.Process, out childExitCode));
            bool cancelled;
            lock (JobLock)
            {
                if (pipeLost) throw new IOException();
                cancelled = cancelRequested;
                if (!cancelled)
                {
                    operationStage = "confirm-job-empty";
                    TerminateAndConfirm(0);
                    naturalCompletion = true;
                }
            }
            if (cancelled)
            {
                if (!control.Join(21000)) throw new TimeoutException();
                lock (JobLock) if (pipeLost) throw new IOException();
            }
            else Send(new Dictionary<string, object> { { "type", "exit" }, { "code", childExitCode }, { "activeProcesses", 0 } });
            return cancelled ? 125 : unchecked((int)childExitCode);
        }
        catch (Exception error)
        {
            string category = error is TimeoutException ? "timeout"
                : error is UnauthorizedAccessException ? "access"
                : error is System.Security.SecurityException ? "security"
                : error is IOException ? "io"
                : error is ArgumentException ? "argument"
                : error is Win32Exception ? "win32"
                : error is InvalidDataException ? "invalid-data"
                : "other";
            try { Send(new Dictionary<string, object> { { "type", "error" }, { "code", "supervisor-failed" }, { "stage", operationStage }, { "category", category } }); } catch { }
            try { if (job != IntPtr.Zero) { TerminateAndConfirm(125); } } catch { }
            Console.Error.WriteLine("Windows command supervision failed (" + operationStage + "," + category + ").");
            return 70;
        }
        finally
        {
            if (hasChild)
            {
                if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
                if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
            }
            if (job != IntPtr.Zero) CloseHandle(job); // KILL_ON_JOB_CLOSE remains the crash/failure fallback.
            if (pipe != null) pipe.Dispose();
        }
    }

    public static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--process-creation") return ProbeProcessCreation(args);
        if (args.Length > 0 && args[0] == "--supervise-host") return RunHost(args);
        return Run(args);
    }
}
