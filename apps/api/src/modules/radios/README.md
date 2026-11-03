# Radio API

Routes under `/api/v1/radios`: the authorized radio list, administrator configuration (`configurations`, `drivers`, `POST /radios`, `PUT /:radioId/configuration`), per-radio state and capabilities, control leases (`/:radioId/control`, `/control/renew`), operations, and channel memories.

Authorize access before calling the radio runtime. Manufacturer details belong in radio drivers.

Specification: [04-radio-runtime.md](../../../../../docs/specifications/04-radio-runtime.md).

`GET /radios/drivers` lists the installed drivers (`InstalledDriver[]`) for administrators, with the same permission as `GET /radios/configurations`. `InstalledDriverRegistry.register(driverId, factory, metadata?)` keeps each driver's metadata: simulators derive it from `simulationDescriptors()`, the station registers metadata for its gRPC drivers, and an undescribed driver gets an open settings schema (Advanced JSON only). `configSchema` describes only the settings the factory reads and never carries secrets.
