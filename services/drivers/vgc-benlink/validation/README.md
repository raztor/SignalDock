# VGC hardware validation tools

Existing Python CLI tools cover discovery/reads, temporary frequency write and restoration, audio conversion, and a bounded TX/PTT proof. `validation_paths.py` keeps output and transport paths anchored to the repository root after relocation.

Run the documented commands from the repository root using its `.venv`. Use `--help` for offline CLI inspection. Validation tools are never invoked by the ordinary simulation/build/test commands. See [hardware validation](../../../../docs/hardware-validation.md).
