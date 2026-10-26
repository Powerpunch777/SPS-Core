# Owned PostgreSQL test fixture cleanup

The embedded test database helper now requests `pg_ctl -m fast -w stop` for its
own temporary cluster and waits for the captured process and stdio close before
removing the fixture. The previous Windows package stop path spawned taskkill
and waited only for a bootstrap process exit; the test helper also swallowed stop
failures. Successful assertions could therefore leave processes or pipes alive.

The helper captures mkdtemp canonical path, device/inode/birth time and the ready
postmaster PID/start time with the expected data directory and port. It verifies
that identity before shutdown and before every recursive removal attempt. Changed
roots, symlinks, mismatched or rewritten PID metadata, missing trusted startup
identity and failed shutdown preserve the fixture and fail cleanup. It does not
enumerate or kill arbitrary PostgreSQL instances. The pg_ctl executable uses the
existing embedded runtime binary override when present.

The process close observer is installed before shutdown; an already exited child
with live stdio still waits for close. Listener/timer cleanup covers rejection
and timeouts, and an early observer rejection remains handled until propagated.
Only the exact pg_ctl helper created here may be terminated on its own timeout;
that is failed cleanup, never a passed test.

This changes the test helper, not installed Host database shutdown or customer
data. Focused tests cover orderly close, already closed children, mismatched
ports and rewritten postmaster IDs. A real Windows support probe completed
initialization/start/normal shutdown and exited naturally. Full integration and
CI must still verify the exact final Core revision. Older abandoned fixtures or
processes without captured identity remain untouched.
