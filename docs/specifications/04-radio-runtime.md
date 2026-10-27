# Radio runtime and multi-radio operation

## Responsibility

The runtime owns configured radio resources, supervises their driver processes, routes control/audio, and enforces local transmission deadlines. It runs close to the hardware. It does not own user passwords, render screens, or invoke speech providers.

The backend supports many runtime/driver instances. Initially they may share one Linux host; the contract leaves room for separately authenticated remote runtimes without requiring that deployment in the first release.

## Resource identity and ownership

Each `radioId` maps to one configured operational resource, driver instance, capability descriptor, state revision, and hardware connection. IDs are independent of manufacturer, memory number, Bluetooth address, or UI position.

One radio has one tuning owner and one TX grant. Independent radios do not block each other. Configurations that share a physical device, serial port, sound interface, or external PTT line declare `resourceGroupIds`; the runtime serializes incompatible operations across that group.

Assigning the same physical endpoint to two active drivers is rejected or explicitly diagnosed. A failed driver marks its own radio unavailable without taking other radios offline. A dashboard radio selection never changes hardware state by itself.

## State and commands

Connection states: `disconnected`, `connecting`, `synchronizing`, `ready`, `degraded`, `recovering`. Keep desired tuning, observed tuning, raw device evidence, and uncertainty separately. Reading an ambiguous device field does not establish the frequency of a recording.

Commands carry `operationId`, `radioId`, expected revision, runtime generation, and the current control grant. Results distinguish accepted, applied, rejected, failed, and unconfirmed. Device writes are verified where supported. Unsupported operations return `CAPABILITY_UNSUPPORTED`, not simulated success.

The runtime and driver use the private contract in [19-radio-driver-sdk.md](19-radio-driver-sdk.md). Product HTTP APIs do not expose Bluetooth frames or manufacturer-specific methods.

## Reconnection and recovery

- Increment runtime/driver generation after restart and invalidate old command/TX grants.
- Reconnect with bounded backoff, read actual state, then accept new writes.
- Never replay TX audio, restore an old PTT assertion, or apply an expired command.
- Detect external controls as revision changes; do not overwrite them using an obsolete snapshot.
- Keep bounded operation records to answer duplicate control requests without repeating physical actions.
- Maintain local TX supervision independently of browser and API connectivity. If physical release cannot be observed after a link failure, publish `stop_unconfirmed` and require reconciliation.

## Initial implementation

`vgc-benlink` is the first driver, using the tested Python library and a minimal Mac transport shim during development. Its device quirks stay in that driver. The tested VR-N7500 is a verified model; related VGC/benlink-family models remain candidates until their own contract and physical tests pass.

## Acceptance

Run two simulated radios with different capabilities, two independent operators, and multiple listeners. Reject duplicate hardware ownership, stale generations, conflicting commands, and unsupported operations. Kill/restart one driver without corrupting the other radio's state or history. Validate the real VGC driver on Mac and subsequently on target Linux hardware.
