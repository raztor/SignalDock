# Backend domain modules

| Module                                   | Status     | Responsibility                  |
| ---------------------------------------- | ---------- | ------------------------------- |
| [instance](instance/README.md)           | Foundation | Instance identity and discovery |
| [health](health/README.md)               | Foundation | Health                          |
| [identity](identity/README.md)           | Planned    | Users and sessions              |
| [radios](radios/README.md)               | Planned    | Radio API                       |
| [media](media/README.md)                 | Planned    | Media signaling                 |
| [history](history/README.md)             | Planned    | Conversations and recordings    |
| [processing](processing/README.md)       | Planned    | Processing orchestration        |
| [incidents](incidents/README.md)         | Planned    | Incident management             |
| [aprs](aprs/README.md)                   | Planned    | Digital decoding and APRS       |
| [notifications](notifications/README.md) | Planned    | Notification orchestration      |
| [admin](admin/README.md)                 | Planned    | Instance administration         |

Each implemented module owns its routes and domain services. Persistence/adapters stay inside the owning module until there is a demonstrated shared boundary. Planned modules contain documentation only and register no routes.
