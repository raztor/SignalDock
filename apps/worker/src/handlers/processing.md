# Processing handler

`registerProcessingHandlers(queue, processing)` registers `processing.execute`. The runtime reauthorizes the initiating user (or explicitly consented service owner), validates source/profile/connection state, resolves encrypted credentials and invokes the generic registry. It saves results through the shared queue's terminal `execution.commit` transaction and deletes generated artifacts when that commit is rejected.

Composition supplies source validation and transcript persistence hooks from history. Provider calls never run inside the terminal commit. Ordinary jobs retain session expiry/revocation; background RX jobs require immutable administrator consent and fresh sessionless service-owner authorization. No cloud calls run during fixture tests. See [the processing guide](../../../../docs/implementation/processing.md).
