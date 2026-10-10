# Paperclip compatibility boundary

SPS-owned server modules import inherited database, shared-contract, adapter,
and control-plane primitives through this directory. The facade keeps existing
behavior available while preventing new SPS features from spreading direct
dependencies on the inherited Paperclip domain.

Do not add product behavior here. Each export must remain a narrow forwarding
adapter with a migration path to an SPS-owned contract.
