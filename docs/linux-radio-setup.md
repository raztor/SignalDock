# Connect a radio on Linux

This guide connects a physical radio to a SignalDock station running on Linux. It applies to an x86-64 mini PC, a Linux server with a USB Bluetooth adapter, or an ARM64 single-board computer. The worked example uses a Raspberry Pi 5 with a 64-bit Debian/Ubuntu-family system and a VGC VR-N7500. Raspberry Pi is an example host, not a requirement.

The Bluetooth commands and container layout are reusable Linux administration steps. The device pairing procedure, driver settings, and capabilities below are specific to the currently implemented `vgc-benlink` connector. Other radios need their own supported connector.

The connection has three separate parts:

| Connection                      | Purpose                                                            | Where it runs                                      |
| ------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| Radio ↔ Linux Bluetooth adapter | BLE control and Bluetooth Classic RFCOMM audio                     | On the host that is physically near the radio      |
| Driver ↔ SignalDock API         | Authenticated private gRPC over a Unix socket                      | Between the driver and API containers on that host |
| Browser ↔ SignalDock            | Login, radio operation, and the configured browser audio transport | Through the station's HTTPS deployment             |

An HTTPS proxy cannot pair the radio, and a Bluetooth bond does not prove that browser audio works. Complete the checkpoints in order. Keep TX disabled during installation and read-only connection checks; enable it later for an explicitly prepared physical test.

## 1. Prepare the host and station

You need:

- A Linux kernel and adapter supporting **both BLE and Bluetooth Classic BR/EDR**. A BLE-only adapter cannot carry the VR-N7500's RFCOMM audio.
- Local Bluetooth access on the machine that will run the driver. A remote Docker daemon or a container inside a VM does not automatically have access to the computer's adapter.
- Docker Engine and its Compose plugin installed for your distribution. See [Docker's installation instructions](https://docs.docker.com/engine/install/).
- A checkout of the repository and a station installed using [the deployment guide](../deploy/README.md), including administrator login. Run the following repository commands from that checkout.

For a Raspberry Pi, use a 64-bit OS and a stable power supply. For another Linux computer, use its built-in adapter or a compatible USB adapter. If the driver runs inside a VM, pass the adapter to that VM and perform all Bluetooth setup inside it.

Debian, Ubuntu, and Raspberry Pi OS example:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends bluez dbus rfkill openssl
sudo systemctl enable --now bluetooth
sudo rfkill unblock bluetooth
```

On other distributions, install the equivalent packages using that distribution's package manager and enable its Bluetooth service. AppArmor and SELinux configuration also differs by distribution; the container example below includes an AppArmor profile for hosts that enforce it.

Check the host before starting a container:

```sh
uname -m
bluetoothctl --version
systemctl is-active bluetooth
rfkill list bluetooth
bluetoothctl list
bluetoothctl show
```

**Checkpoint:** the service is active, an adapter appears, and Bluetooth is neither soft-blocked nor hard-blocked. A hard block requires correcting the physical switch, firmware, or host configuration; `rfkill unblock` cannot remove it.

## 2. Identify and power the intended adapter

List kernel adapter names and their controller addresses:

```sh
ls /sys/class/bluetooth
bluetoothctl list
busctl get-property org.bluez /org/bluez/hci0 org.bluez.Adapter1 Address
```

The D-Bus query identifies the controller address for `hci0` on the systemd-based example host. Use an interactive session to select that controller if necessary. Replace `CONTROLLER_MAC` with that address; placeholders in these interactive examples are not shell variables.

```text
bluetoothctl
list
select CONTROLLER_MAC
show
power on
```

Wait until `Powered: yes` before pairing. If power-on reports `Busy`, inspect the current power state and wait for the transition to finish before retrying.

The current Linux driver's cached-device lookup uses `/org/bluez/hci0`. The examples therefore use the controller corresponding to **hci0**. `bluetoothctl select` changes that tool's selection; it does not configure the driver's adapter. There is currently no driver JSON field for choosing `hci1` or another adapter. If the radio must use another controller, resolve that driver limitation before relying on this setup.

**Checkpoint:** you know which physical adapter is `hci0`, and it is powered. Keep the radio close to that adapter during initial setup.

## 3. Put the radio in pairing mode and pair it

Disconnect the radio from phone applications and other computers so they do not reclaim its connection during setup. On the VR-N7500, switch the radio on and press **POWER twice**. The beep and alternating red/green lights indicate pairing mode; see the manufacturer's [fast operation manual](https://fcc.report/FCC-ID/ZVMVR-N7500/4568252.pdf).

In `bluetoothctl`:

```text
agent off
agent NoInputNoOutput
default-agent
pairable on
scan on
```

Identify the intended radio by its address and proximity. A display name alone is not a unique identifier. Replace every `RADIO_MAC` below with that address:

```text
info RADIO_MAC
pair RADIO_MAC
trust RADIO_MAC
info RADIO_MAC
```

Wait for `Pairing successful`; an `Attempting to pair` message alone is not success. If pairing fails after the radio leaves pairing mode, put it back into pairing mode and retry. Follow the device's actual pairing prompts rather than guessing a PIN.

The VR-N7500 can present Classic and BLE under the same public MAC address. Other hardware may use separate identifiers. Record what your host discovers instead of deriving one address from the other.

## 4. Verify both Bluetooth bearers

The generic `Paired: yes` or `Bonded: yes` status may describe only one bearer. On BlueZ versions that expose per-bearer commands, check each one from a second shell:

```sh
bluetoothctl le.show RADIO_MAC
bluetoothctl bredr.show RADIO_MAC
```

Inspect `bluetoothctl --help` for availability on your distribution. With the BlueZ 5.87 dual-mode behavior, another `pair RADIO_MAC` request can pair the remaining bearer after the first is bonded. Re-enter pairing mode on the radio immediately before that request. Recheck that **both** bearers report paired/bonded; do not delete an existing working bond as the first troubleshooting step.

Some releases expose bearer inspection and selection only when experimental D-Bus interfaces are enabled. If those interfaces are needed and supported by the installed version, back up `/etc/bluetooth/main.conf`, edit its existing `[General]` section, and set:

```ini
[General]
Experimental = true
```

Restarting Bluetooth disconnects devices using that service. Perform the restart before putting the station into use:

```sh
sudo systemctl restart bluetooth
bluetoothctl show
```

With both bonds present and the device disconnected, versions supporting the preferred-bearer setting can select BLE for control:

```sh
bluetoothctl bearer RADIO_MAC le
```

If connection attempts still choose Classic, inspect the bearer state and the Bluetooth journal. On versions providing `le.connect`, an explicit BLE connection can help diagnose the selected bearer:

```sh
bluetoothctl le.connect RADIO_MAC
bluetoothctl le.show RADIO_MAC
bluetoothctl info RADIO_MAC
journalctl -u bluetooth --since '5 minutes ago' --no-pager
```

A successful command return is not sufficient: wait for the actual connection/service state and later confirm a device/status read through the driver. Avoid running discovery or a second radio-control application continuously alongside the driver.

Finish the interactive pairing session:

```text
scan off
pairable off
quit
```

**Checkpoint:** both required bonds persist, the intended radio is trusted, and discovery/pairable mode are off. `Connected: no` while no driver is using the radio is normal. See [BlueZ's device API](https://github.com/bluez/bluez/blob/5.87/doc/org.bluez.Device.rst) for bearer-selection behavior and version-dependent properties.

## 5. Create a disabled radio configuration in SignalDock

Sign in as an administrator and open **Radios → Station radio configuration → Add radio**:

| Field                   | Example value                                                                  |
| ----------------------- | ------------------------------------------------------------------------------ |
| Driver                  | VGC / benlink                                                                  |
| Display name            | VR-N7500                                                                       |
| Private driver endpoint | `unix:/run/signaldock/vgc/vgc.sock`                                            |
| Shared resource groups  | Leave empty for a single radio; use a common group for radios sharing hardware |
| Radio enabled           | Off during initial setup                                                       |
| Driver credential       | `vgc-linux-radio`                                                              |
| Connection timeout      | `30000` ms                                                                     |

Save the disabled configuration and record its **`radioId` UUID**. The Python driver must use exactly this ID. If the UI does not display it, inspect the radio-save JSON response in the browser's Network panel, or the authenticated administrator `GET /api/v1/radios/configurations` response. Copy only the `radioId`; credentials are not needed for this step. Include the deployment's API prefix if one is configured.

Saving a configuration does not grant operational access, even to an administrator. Access assignment comes after connection verification below.

## 6. Prepare private driver files

This example runs the driver as UID/GID `1000:1000` to match the API's `node` user. The standalone driver image normally uses UID `10001`; that default would not share its mode-0600 socket with the API. Verify the API identity in your deployment:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T api id
```

Adapt the ownership and container user together if your API uses another UID. The host user with that number need not have the same name as the user inside the container.

Create private configuration and runtime directories:

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /etc/signaldock/vgc
sudo install -d -m 0700 -o 1000 -g 1000 /var/lib/signaldock-vgc/runtime
sudo sh -c 'umask 077; set -C; openssl rand -hex 32 > /etc/signaldock/vgc/driver-token'
```

The token command refuses to overwrite an existing file. Preserve an existing token during updates. Do not print or commit it.

Create `/etc/signaldock/vgc/config.json` with `sudoedit`. Replace the sample UUID with the application's `radioId`, and replace both sample MACs with the verified device identifiers:

```json
{
  "radioId": "11111111-1111-4111-8111-111111111111",
  "bleAddress": "AA:BB:CC:DD:EE:FF",
  "classicAddress": "AA:BB:CC:DD:EE:FF",
  "audioChannel": 2,
  "allowExperimentalTx": false
}
```

`audioChannel` is the **RFCOMM service channel**, not an RF frequency or radio memory number. `2` is the connector's default; verify the appropriate service for your device/firmware if audio opening fails. Do not select the Hands-Free profile merely because it appears in Bluetooth discovery.

Leave `workingMemoryId` absent initially. Setting it reserves a memory that generic tuning may overwrite and selects both A/B sides onto it. Choose that slot deliberately later; the example does not reserve one automatically.

Create `/etc/signaldock/vgc/driver-credentials.json`:

```json
{
  "vgc-linux-radio": "/run/signaldock/vgc.token"
}
```

The value is the token path **inside the API container**. The reference name must match the UI's Driver credential field. The radio's JSON configuration belongs to the Python driver and must not be pasted into the UI's generic gRPC settings.

Set permissions after creating the files:

```sh
sudo chown 1000:1000 /etc/signaldock/vgc/config.json /etc/signaldock/vgc/driver-token /etc/signaldock/vgc/driver-credentials.json
sudo chmod 0600 /etc/signaldock/vgc/config.json /etc/signaldock/vgc/driver-token /etc/signaldock/vgc/driver-credentials.json
```

## 7. Configure container access to host Bluetooth

The driver needs the host's system D-Bus socket for BlueZ and the host network namespace for kernel Bluetooth RFCOMM. The API needs only the credential files and private Unix-socket directory. The web container needs neither Bluetooth nor those mounts. [Docker host networking](https://docs.docker.com/engine/network/drivers/host/) shares the host network namespace; do not add public driver ports.

### AppArmor hosts

If AppArmor is enforcing, a read-only D-Bus bind mount alone may still produce `AccessDenied` under `docker-default`. Use a profile specific to this driver rather than changing the policy for every container or using `privileged`.

Install your distribution's AppArmor parser and status tools if they are missing. On Debian/Ubuntu-family systems, these are supplied by the `apparmor` and `apparmor-utils` packages.

Create `/etc/apparmor.d/signaldock-vgc`:

```text
#include <tunables/global>
profile signaldock-vgc flags=(attach_disconnected,mediate_deleted) {
  file,
  network unix,
  network bluetooth,
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (send,receive) peer=signaldock-vgc,
  dbus (send) bus=system peer=(name=org.freedesktop.DBus),
  dbus (send,receive) bus=system peer=(name=org.bluez),
  dbus (receive) bus=system peer=(name=org.freedesktop.DBus),
  dbus (receive) bus=system path=/org/bluez{,/**},
  dbus (receive) bus=system path=/ interface=org.freedesktop.DBus.ObjectManager,
  deny mount,
  deny /proc/sys/** wklx,
  deny /proc/sysrq-trigger rwklx,
  deny /proc/{kcore,mem,kmem} rwklx,
  deny /sys/** wklx,
}
```

Load and inspect it:

```sh
sudo apparmor_parser -r /etc/apparmor.d/signaldock-vgc
sudo aa-status
```

This profile relies on a read-only container filesystem and the narrowly mounted writable runtime directory below. The signal rules allow container shutdown, including hosts confining `runc` under its own profile. A host using another runtime/profile name may need an equivalent receive rule identified from its denial log. Ensure the profile loads before the container starts after reboot. See [Docker's AppArmor documentation](https://docs.docker.com/engine/security/apparmor/) for profile loading and diagnosis.

On a host without AppArmor, omit only the `apparmor:signaldock-vgc` line from the next example. If SELinux is enforcing, configure the equivalent host/container policy for BlueZ and the private mounts; do not disable SELinux or apply a private-volume relabel option to the host's system D-Bus socket. Distribution D-Bus policies may also require a host Bluetooth group; inspect the installed policy and use its numeric GID as a supplementary container group if required.

### Private Compose override

Create `/etc/signaldock/vgc/compose.yaml`:

```yaml
services:
  api:
    environment:
      SIGNALDOCK_DRIVER_CREDENTIALS_FILE: /run/signaldock/driver-credentials.json
    volumes:
      - /etc/signaldock/vgc/driver-credentials.json:/run/signaldock/driver-credentials.json:ro
      - /etc/signaldock/vgc/driver-token:/run/signaldock/vgc.token:ro
      - /var/lib/signaldock-vgc/runtime:/run/signaldock/vgc:ro
  vgc:
    image: signaldock-vgc:local
    build:
      context: ..
      dockerfile: services/drivers/vgc-benlink/Dockerfile
    user: '1000:1000'
    network_mode: host
    environment:
      DBUS_SYSTEM_BUS_ADDRESS: unix:path=/var/run/dbus/system_bus_socket
    volumes:
      - /var/run/dbus/system_bus_socket:/var/run/dbus/system_bus_socket:ro
      - /etc/signaldock/vgc/config.json:/etc/signaldock-vgc/config.json:ro
      - /etc/signaldock/vgc/driver-token:/etc/signaldock-vgc/token:ro
      - /var/lib/signaldock-vgc/runtime:/var/lib/signaldock-vgc
    command:
      - --config
      - /etc/signaldock-vgc/config.json
      - --socket
      - /var/lib/signaldock-vgc/vgc.sock
      - --token-file
      - /etc/signaldock-vgc/token
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
      - apparmor:signaldock-vgc
    tmpfs: ['/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000']
    restart: unless-stopped
    stop_grace_period: 45s
    logging:
      driver: local
      options: { max-size: 10m, max-file: '3' }
```

Keep this override private. When merged with `deploy/compose.yaml`, the API keeps its existing `/data` volume and other environment settings. Do not replace that volume or start a second radio-owning API against the same station. Relative build paths in the override resolve from the first Compose file, so `context: ..` remains the repository root.

```sh
sudo chmod 0600 /etc/signaldock/vgc/compose.yaml
```

From the repository root, define a helper for this shell session:

```sh
SIGNALDOCK_REPO="$(pwd -P)"
sd() {
  sudo docker compose \
    --env-file "$SIGNALDOCK_REPO/deploy/.env" \
    -f "$SIGNALDOCK_REPO/deploy/compose.yaml" \
    -f /etc/signaldock/vgc/compose.yaml "$@"
}
```

Include any additional private overrides already required by your station, and preserve its Compose project name. Use the same complete file list for later starts, stops, updates, and backups that require the running deployment's configuration. Avoid printing the expanded Compose configuration: it can contain deployment credentials.

## 8. Validate files, then start the driver

```sh
sd config --quiet
sd build vgc
sd run --rm --no-deps vgc --config /etc/signaldock-vgc/config.json --check-config
sd up -d --build vgc api
sd ps
sd logs --tail 50 vgc
```

`--check-config` validates the file without connecting to a radio or opening a listener. Starting the service creates its private socket; hardware connection happens when the API enables the radio. The image supplies Python, FFmpeg, and generated bindings; the Docker host does not need the Mac validation environment.

Check the files and socket without reading the token:

```sh
sudo stat -c '%a %u:%g %n' /etc/signaldock/vgc/driver-token /var/lib/signaldock-vgc/runtime/vgc.sock
sd exec -T api id
sd exec -T api node -e 'const fs=require("fs"); console.log(fs.statSync("/run/signaldock/vgc/vgc.sock").isSocket())'
```

**Checkpoint:** the driver remains running, the token and socket have mode `600`, and the API can see the socket under its configured endpoint. This proves mounting and startup, not physical radio readiness.

## 9. Enable the radio and assign access

Return to the saved radio configuration, enable it, and save/reconnect. The backend performs its private driver handshake and fresh hardware readback.

In **Users & access**, assign the intended account a level for this radio:

- **Listen** for monitoring.
- **Control** for listening plus supported control/memory operations.
- **Transmit** only when transmission access is intended; it includes the lower levels.

Changing your own account's permissions signs you out of existing sessions. Sign back in before checking the radio card.

Select the radio and verify that it reaches a ready/connected state and reports physical TX idle. Do not substitute a running container, generic Bluetooth `Connected: yes`, or successful HTTP health response for that hardware readback.

The driver may correctly report **frequency unknown** when the A/B selections differ, scanning or dual watch is active, or a selected memory cannot be verified. Read the memories and deliberately select the desired programmed memory through SignalDock if a single confirmed destination is required. Selection changes the radio's settings; it is not an installation probe. Do not infer the operating frequency from `curr_ch_id` alone.

## 10. Verify audio, transmission, and restarts separately

Follow [the deployed media configuration](../deploy/README.md#live-media) for the browser-to-backend audio path. That path is separate from Bluetooth and depends on the transport available in the deployed revision. The private Bluetooth driver socket never needs an Internet-facing port.

Verify these stages independently:

1. Confirm device identity, hardware status, and physical idle without changing frequency or emitting audio.
2. Open RX on the Classic RFCOMM service and receive a known signal. Confirm actual browser playback, not only successful socket opening.
3. For a prepared TX test, verify the selected memory, RX/TX frequencies, mode and sub-audio settings. Set `allowExperimentalTx` to `true` in the private driver JSON, restart the driver, reconnect the radio configuration so capabilities are read again, and assign the intended user's Transmit permission. These are separate gates; a permission grant alone does not enable driver TX.
4. Perform an explicitly coordinated microphone/PTT test with an independent receiver/observer. Confirm carrier start, audio, release, and physical return to idle. The connector's transmission limits remain in force.
5. Test an ordinary driver/API restart with no transmission active. Verify clean socket removal/recreation, reconnection and fresh state, and that TX does not resume automatically. Test host reboot only when it will not interrupt other services.

After reconnecting, inspect the current driver and API state again. Depending on the failure, saving/reconnecting the radio configuration or restarting the API may be needed to repeat the handshake. A driver restart alone is not evidence that the backend has recovered.

Keep an installation record with OS/architecture, kernel and BlueZ versions, adapter model, repository revision, and which stages actually passed. Back up the private configuration/token map and runtime recovery journal along with the station's normal backup. Exclude these files and device-specific reports from Git. See [driver behavior and recovery](implementation/vgc.md) and [physical acceptance evidence](implementation/vgc-acceptance.md).

## Troubleshooting

| Symptom                                               | Check and next action                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No controller appears                                 | Check kernel recognition/firmware, USB connection or VM passthrough, `rfkill`, and `journalctl -u bluetooth`. The container cannot create a missing host adapter.                                                                                                               |
| `AuthenticationFailed` or only one bearer bonded      | Re-enter the radio's pairing mode, disconnect competing clients, and inspect Classic and LE separately. A stored Classic bond is not BLE acceptance.                                                                                                                            |
| `BREDR.ProfileUnavailable` during control connection  | Verify the LE bond and actual bearer state; use supported bearer-selection commands. A visible Hands-Free service does not establish the connector's BLE control path.                                                                                                          |
| Device not found although already connected           | Check the configured MAC, `hci0`, other clients, and deployed revision. The current driver can use a cached BlueZ device rather than requiring a fresh advertisement.                                                                                                           |
| D-Bus `AccessDenied`                                  | Verify the system-bus mount/address, host D-Bus policy and container UID/groups. On AppArmor hosts, inspect `journalctl -k` for denied `Hello`, `AddMatch`, BlueZ methods or notifications and load the driver-specific profile.                                                |
| Container cannot stop cleanly                         | Inspect AppArmor signal denials, including a `runc` peer. Correct the specific rule and verify a normal stop before relying on automatic restart.                                                                                                                               |
| Driver says its socket already exists                 | Stop the driver and inspect container processes and `ss -xlpn`. Check for a live listener before removing a confirmed stale socket. Never delete it repeatedly while a live process or restart loop may own it. Inspect any pending recovery journal before resuming writes/TX. |
| API cannot authenticate or open the driver            | Match the endpoint, `radioId`, credential reference, API-container token path, UID and mode-0600 ownership. After changing the credential map, recreate the API so startup reloads it.                                                                                          |
| Frequency unknown                                     | Inspect A/B selection, scanning and memory validity. Only an intentional memory selection/readback can establish the destination; pairing cannot.                                                                                                                               |
| Control works but audio does not                      | Check `audioChannel`, the Classic bond, RFCOMM/host-network access, FFmpeg/SBC availability, and the separately configured browser media transport.                                                                                                                             |
| Radio absent from an administrator's operational list | Assign explicit radio access to that account. Configuration administration and operational access are separate.                                                                                                                                                                 |
| `stop_unconfirmed`                                    | Keep the radio unavailable for further TX until pending work settles and a fresh physical idle observation succeeds. Follow the driver recovery procedure if a journal remains.                                                                                                 |

When gathering diagnostics, omit token contents, authorization headers, private recordings, and full expanded environment/configuration output.
