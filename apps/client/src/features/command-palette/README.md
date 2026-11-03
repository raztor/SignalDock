# Command palette

`CommandPalette` is a search overlay opened from the workspace header's search button (all platforms) or with ⌘K / Ctrl+K on web (`usePaletteShortcut`; ignored while another text field has focus unless the palette is open). One text field filters ranked results; ↑/↓ move the highlight, Enter runs and Escape closes. It must render inside `ToastProvider`, `StationProvider` and `MediaProvider`; App renders it inside the workspace.

Providers build commands from station state: a typed frequency ("Tune <radio> to 146.550 FM", parsed with the radio's tuning ranges and current mode), memories ("Recall <name>"), radios ("Select <radio>", which never retunes), sections ("Go to History", through the workspace's navigation so transmission still stops), open incidents by title (`GET incidents?state=…&limit=20` for new, acknowledged and in-progress, fetched on the first keystroke and cached for 30 s; choosing one opens its detail in Incidents), take/release control and start/stop listening.

Commands that cannot run stay listed with their reason (for example "Take control first."); running one shows a warning toast instead of sending anything, with a "Take control" action where that fixes it. Control is never taken and a frequency is never retuned implicitly. Writes check that the selected radio did not change before sending. Every run reports its result as a toast.

Pure logic (ranking, providers, gating, shortcut rules) lives in `command-model.ts` and is tested in `command-model.test.ts`; HTTP for incidents is in `incident-source.ts`.
