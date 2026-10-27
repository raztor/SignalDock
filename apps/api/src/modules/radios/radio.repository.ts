import {
  RadioConfigurationSchema,
  type DatabasePort,
  type MigrationDefinition,
  type RadioConfiguration,
} from '@signaldock/contracts';

export const radioMigrations: readonly MigrationDefinition[] = [
  {
    id: '015_radios',
    sql: `
CREATE TABLE IF NOT EXISTS sd_radios (
  instance_id uuid NOT NULL,
  id uuid NOT NULL,
  display_name text NOT NULL,
  driver_id text NOT NULL,
  endpoint text,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  resource_group_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id,id),
  CHECK (jsonb_typeof(configuration) = 'object'),
  CHECK (jsonb_typeof(resource_group_ids) = 'array')
);
CREATE UNIQUE INDEX IF NOT EXISTS sd_radios_active_endpoint
ON sd_radios(instance_id,endpoint) WHERE enabled AND endpoint IS NOT NULL;
`,
  },
];

export class RadioRepository {
  constructor(
    private readonly database: DatabasePort,
    private readonly instanceId: string,
  ) {}
  async list(): Promise<RadioConfiguration[]> {
    const result = await this.database.query(
      'SELECT * FROM sd_radios WHERE instance_id=$1 ORDER BY created_at,id',
      [this.instanceId],
    );
    return result.rows.map(fromRow);
  }
  async save(config: RadioConfiguration): Promise<void> {
    await this.database.query(
      `INSERT INTO sd_radios(instance_id,id,display_name,driver_id,endpoint,configuration,resource_group_ids,enabled)
VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
ON CONFLICT(instance_id,id) DO UPDATE SET display_name=excluded.display_name,driver_id=excluded.driver_id,
endpoint=excluded.endpoint,configuration=excluded.configuration,resource_group_ids=excluded.resource_group_ids,
enabled=excluded.enabled,updated_at=now()`,
      [
        this.instanceId,
        config.radioId,
        config.displayName,
        config.driverId,
        config.endpoint ?? null,
        JSON.stringify(config.config),
        JSON.stringify(config.resourceGroupIds),
        config.enabled,
      ],
    );
  }
}
function fromRow(row: Record<string, unknown>): RadioConfiguration {
  return RadioConfigurationSchema.parse({
    radioId: row['id'],
    displayName: row['display_name'],
    driverId: row['driver_id'],
    ...(row['endpoint'] ? { endpoint: row['endpoint'] } : {}),
    config: row['configuration'],
    resourceGroupIds: row['resource_group_ids'],
    enabled: row['enabled'],
  });
}
