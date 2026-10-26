# Backend composition

`create-server.ts` configures the Fastify instance and explicitly registers implemented routes. `base-path.ts` normalizes the deployment prefix. Process environment, identity loading, listening, and shutdown remain in `src/main.ts`.
