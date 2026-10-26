# Cursor SDK dependency compatibility

The Cursor cloud adapter now pins the actual published `@cursor/sdk` 1.0.40.
Published 1.0.19 required Zod 3 as a runtime dependency. The new release declares
a Zod 3/4 peer and uses v3 compatibility declarations where required; the adapter
resolves that peer to the existing official Zod 4.6.6 package. Other first-party
Core consumers still require the patched Zod 3 package, so this update does not
clear the Zod security advisory or change audit exceptions.

The adapter's used creation/resumption, model listing, run streaming/waiting and
message interfaces remain compatible. The newer release adds usage messages and
run-error typing. Existing execute tests passed 4/4, adapter typecheck passed,
and real installed runtime imports exposed Agent.create and Cursor.models.list.
Frozen filtered installation passed. No real provider request or account was
used, so external service behavior remains separately unqualified.

Lock changes are limited to the SDK, its platform packages and its Zod peer
context. Existing Better Auth Zod 4 context and exact Zod 3 patch registration
remain intact. Rollback restores the previous adapter dependency and lock entries;
there is no data migration or mandatory AI activation.
