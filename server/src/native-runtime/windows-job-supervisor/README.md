# Core Windows plugin-worker process ownership

This folder carries the SPS Windows Job Object supervisor used to own a Core
plugin worker's process tree. The JavaScript transport and native helper are
based on the SPS Desktop Node implementation at
`sps-server/desktop-node/src/windows-job-supervisor.mjs` and
`sps-server/desktop-node/native/windows-job-supervisor/WindowsJobSupervisor.cs`.
The Core copy has one protocol extension: the helper's ready frame includes the
verified target PID so Core diagnostics do not mistake the helper PID for the
worker PID.

The native helper is compiled on demand with the .NET Framework compiler already
installed on Windows. It is written to a unique private temporary directory;
that directory is retained for the Core process lifetime so cleanup cannot
race a loaded helper executable. Failed compilation removes the directory only
when its canonical path and filesystem identity still match the directory
created by that attempt. The adapter does not download tools, search for or
adopt old processes, or fall back to an unsupervised Windows worker. The supervisor owns process-tree
termination only. It does not provide an OS security sandbox or filesystem,
network, credential, or identity isolation.

The copied files remain covered by the repository MIT license. The original
SPS Desktop Node files are retained unchanged.
