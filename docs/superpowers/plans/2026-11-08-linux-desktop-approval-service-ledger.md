# Linux approval service execution ledger

Approved plan: `2026-11-08-linux-desktop-approval-service.md`.

## Resume checkpoint

Resumed from clean `feat/linux-appimage` at `02a9db42`. The shared checkout is
on another task branch and is untouched. Foundation verification remains in
`docs/security/linux-provenance-acceptance.md`; no installed approval claim.

Task 4, partial: added atomic activation record, explicit phase transitions,
epoch high-water mark, higher-epoch recovery, root-held lock, conservative fresh
initialization and poisoned-store handling. New integration tests first failed
because the module and recovery method did not exist; both passed after
implementation. Local disk fault tests cover all four persistence boundaries
for each phase transition. CI adds a root-owned isolated filesystem fixture.

Ruling: keep transaction selection and recovery state in one atomic record,
rather than independently mutable transaction/active files -- this prevents
mixed generations after rename boundaries -- integrations must use this record
as their single selector or the guarantee does not hold.

Task 4 remains incomplete: real service orchestration, complete signed-tree
revalidation at activation, process-kill/service-boundary fault testing,
uninstall, repair and installed rollback acceptance still remain. Task 2 trusted
launch/exec attestation and Task 3 lifecycle/enrollment/disclosure are not complete.
No VM installation was attempted.

Independent checkpoint review found a restart defect: a durable pending prepare
could be ignored and the old Ready record admitted. Added a regression beginning
from a healthy active installation (initially failed for missing pending-state
guard), closed ordinary reopen when any pending record exists, and added explicit
recovery retaining the pending epoch before advancing again. Native CI fixture
now checks epoch 2 -> interrupted pending 3 -> recovered 4 and unchanged journal
bytes. Torn pending records fail closed for investigation.

Added subprocess termination tests at each write/fsync/rename boundary for an
update from an already healthy installation. These verify abrupt process death,
not power loss. Real service-boundary termination tests remain outstanding.

Ruling: an unreadable/torn pending record cannot be automatically repaired -- its
epoch is not safely knowable -- installation remains closed until an explicit
administrator recovery procedure can establish history; deleting it is not repair.
